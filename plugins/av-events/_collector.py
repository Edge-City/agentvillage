"""Config, session bookkeeping, the buffer flusher and the fail-open decorator.

`_core` holds the primitives; this module holds the state machine. `__init__`
holds `register(ctx)` and the hook adapters, and is the only module that knows
anything about Hermes.
"""

from __future__ import annotations

import atexit
import functools
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any, Callable, Optional

from ._core import (
    BACKOFF_BASE_S,
    BACKOFF_MAX_S,
    CAPTURE_MODES,
    CONFIG_TTL_S,
    DEFAULT_CAPTURE,
    DIR_MODE,
    EVIDENCE_CLASS,
    EXIT_FLUSH_BUDGET_S,
    FILE_MODE,
    FLUSH_INTERVAL_S,
    HOOK_BUDGET_MS,
    MAX_BUFFER_AGE_S,
    MAX_FILES_PER_TICK,
    MAX_PROCESS_FAILURES,
    MAX_SESSION_FAILURES,
    MAX_TRACKED_SESSIONS,
    SCHEMA_VERSION,
    TICK_INTERVAL_S,
    Buffer,
    SendResult,
    cron_run_event_id,
    env,
    env_flag_disabled,
    hermes_home,
    now_iso,
    post_events,
    register_literal_secret,
    sanitize,
    sqlite_read,
    uuid7,
)
from . import _backup
from ._cron import CronCursor, cron_job_id_from, pending_runs
from ._edgeos import Ledger

#: How often the flusher thread looks for finished cron executions.
CRON_POLL_INTERVAL_S = 60.0

#: `USER.md` larger than this is not read: Hermes caps it at a few KiB.
MAX_PROFILE_BYTES = 1024 * 1024

#: Hermes `sessions.cost_status` / `cost_source` values leave only in this shape.
_COST_LABEL = re.compile(r"^[a-z0-9_.:-]{1,64}$")

_HEX64 = re.compile(r"^[0-9a-f]{64}$")

logger = logging.getLogger("av-events")

#: Counters already logged by this process. Each is logged once, as a name and
#: a count — never the value that tripped it.
_LOGGED_COUNTERS: set[str] = set()

#: The two USER.md files `profile.updated` reports, by `kind`. Hermes's memory
#: tool writes the first (`tools/memory_tool.py`); the landing's enrichment
#: writes the second, through the control-plane sidecar (`USER_FILE =
#: $HERMES_DATA/USER.md`, the Hermes home) and the installer's
#: `targetWorkspace()` (= `$HERMES_HOME`, which is `~/.hermes` by default).
PROFILE_FILES = (
    ("memory_profile", ("memories", "USER.md")),
    ("landing_profile", ("USER.md",)),
)

def _bump(counters: Optional[dict], name: str) -> None:
    if counters is not None:
        counters[name] = counters.get(name, 0) + 1


#: How long a reader waits for a key another process is still writing (the
#: `O_EXCL` fallback writes in place) before calling the file corrupt.
KEY_WRITE_GRACE_S = 0.5
_HEX_PREFIX = re.compile(r"^[0-9a-f]{0,63}$")


def _write_new_key(directory: str) -> str:
    """A fresh key written to a private temp file in `directory`; returns its path."""
    temp = os.path.join(directory, f".hash.key.{os.getpid()}.{secrets.token_hex(4)}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, FILE_MODE)
    with os.fdopen(fd, "w", encoding="ascii") as handle:
        handle.write(secrets.token_hex(32))
    return temp


def _create_key(directory: str, path: str, counters: Optional[dict]) -> None:
    """Put a key at `path` unless one is already there. Raises `OSError` on failure.

    A complete temp file is hard-linked into place: the link fails if another
    process got there first, and no reader ever sees a partial file. On a
    filesystem without hard links (`os.link` raising anything but
    `FileExistsError`), the key is written in place with `O_CREAT | O_EXCL`
    and fsynced — still exactly one winner, and a reader that catches the
    write half-done waits for it (`KEY_WRITE_GRACE_S`) rather than replacing it.
    """
    os.makedirs(directory, mode=DIR_MODE, exist_ok=True)
    temp = _write_new_key(directory)
    try:
        os.link(temp, path)
        _bump(counters, "hash_key_generated")
        return
    except FileExistsError:
        return  # another process won
    except OSError:
        pass  # no hard links here: fall back below
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, FILE_MODE)
    except FileExistsError:
        return
    try:
        os.write(fd, secrets.token_hex(32).encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    _bump(counters, "hash_key_generated")


def load_or_create_key(directory: str, counters: Optional[dict] = None) -> Optional[bytes]:
    """Per-tenant random key at `<directory>/hash.key`: 64 hex characters, mode 0600.

    A key, once written, is never rotated by a race or a hiccup:

    - read succeeds, content valid: that is the key;
    - read succeeds, content empty or a hex prefix: another process is still
      writing it (the no-hard-link fallback); re-read for up to
      `KEY_WRITE_GRACE_S`;
    - read succeeds, content otherwise not 64 hex: the file is corrupt and is
      replaced (`os.replace` from a complete temp file), then read back;
    - file absent: `_create_key`, then read whatever won;
    - any other `OSError` (permissions, I/O, a missing directory that cannot
      be made): None. The caller keys nothing for now and retries later.
    """
    path = os.path.join(directory, "hash.key")
    deadline = time.monotonic() + KEY_WRITE_GRACE_S
    replaced = created = False
    while True:
        try:
            with open(path, "rb") as handle:
                raw = handle.read(256)
        except FileNotFoundError:
            if created:
                return None
            created = True
            try:
                _create_key(directory, path, counters)
            except OSError:
                return None
            continue
        except OSError:
            return None
        text = raw.decode("ascii", errors="replace").strip()
        if _HEX64.match(text):
            return bytes.fromhex(text)
        if _HEX_PREFIX.match(text) and not raw.endswith(b"\n") and time.monotonic() < deadline:
            time.sleep(0.005)
            continue
        if replaced:
            return None
        replaced = True
        # Read fine, content invalid: the file is corrupt. Replace it.
        try:
            temp = _write_new_key(directory)
            try:
                os.replace(temp, path)
                _bump(counters, "hash_key_replaced")
            finally:
                try:
                    os.unlink(temp)
                except FileNotFoundError:
                    pass
        except OSError:
            return None


# --------------------------------------------------------------------------
# Runtime facts
# --------------------------------------------------------------------------

_VERSION_CACHE: dict[str, Optional[str]] = {}


def hermes_version() -> Optional[str]:
    """Best-effort Hermes version, or null. Never imports Hermes eagerly."""
    if "hermes" in _VERSION_CACHE:
        return _VERSION_CACHE["hermes"]
    value: Optional[str] = env("HERMES_VERSION") or None
    if value is None:
        try:  # pragma: no cover - depends on the host install
            from hermes_cli import __version__ as _hv  # type: ignore

            value = str(_hv) or None
        except Exception:  # noqa: BLE001
            value = None
    _VERSION_CACHE["hermes"] = value
    return value


def overlay_ref() -> Optional[str]:
    """The Edge City overlay commit this sandbox was installed from, or null."""
    if "overlay" in _VERSION_CACHE:
        return _VERSION_CACHE["overlay"]
    value = env("OVERLAY_REF") or env("AV_OVERLAY_REF") or None
    _VERSION_CACHE["overlay"] = value
    return value


def reset_runtime_cache() -> None:
    """Test seam: version lookups are cached for the life of the process."""
    _VERSION_CACHE.clear()


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


class Config:
    """Resolved at plugin load and again at the start of every session.

    Re-reading at session start is what makes the kill switches work without a
    redeploy (guardrails §2): the control plane rewrites the sandbox env or
    `$HERMES_HOME/.env`, and the next session picks it up.
    """

    __slots__ = (
        "enabled", "url", "token", "capture", "disabled_hooks", "home", "buffer_dir", "state_dir", "tenant_id",
        "backup_url", "backup_url_refused", "backup_token", "backup_tenant", "backup_max_bytes",
        "backup_min_interval_s",
    )

    def __init__(self) -> None:
        self.enabled = not env_flag_disabled("AV_EVENTS_ENABLED")
        self.url = env("AV_EVENTS_URL").rstrip("/")
        self.token = env("AV_EVENTS_TOKEN")
        capture = env("AV_CAPTURE").lower() or DEFAULT_CAPTURE
        self.capture = capture if capture in CAPTURE_MODES else DEFAULT_CAPTURE
        # Case-insensitive, whitespace-tolerant: this is a switch an operator
        # types into a Railway variable box, not a config file.
        self.disabled_hooks = frozenset(
            part.strip().lower() for part in env("AV_HOOKS_DISABLED").split(",") if part.strip()
        )
        self.home = hermes_home()
        self.state_dir = os.path.join(self.home, "av-events")
        self.buffer_dir = os.path.join(self.state_dir, "buffer")
        # Only for `cron.run`'s derived id (spec §4.3), which ingest recomputes
        # from the token's tenant. `TENANT_ID` is what the control plane already
        # sets for `plugins/dashboard-auth-edgecity`; `AV_TENANT_ID` overrides.
        tenant = env("AV_TENANT_ID") or env("TENANT_ID")
        # Lower-cased, as ingest lower-cases it before recomputing the id: an
        # upper-case UUID in the env must not change every `cron.run` id.
        self.tenant_id = tenant.lower() if 0 < len(tenant) <= 128 else ""
        register_literal_secret(self.token)
        # Memory snapshot (DATA-82, `_backup`). Its own URL and token: the
        # backup route is not the events route, and the token is a different
        # class (`backup_write`). The tenant is used exactly as given — it is a
        # bucket key segment and the input the route derives the token from,
        # so lower-casing it (as `cron.run` does) could only break the match.
        #
        # The URL is read from the process environment only, never the
        # `$HERMES_HOME/.env` fallback: the agent can write that file, and the
        # backup token goes wherever this URL points. It must be https, or
        # plain http to `*.railway.internal` or the local machine.
        url = (os.environ.get("AV_BACKUP_URL") or "").strip()
        allowed = not url or _backup.backup_url_allowed(url)
        self.backup_url = url if allowed else ""
        self.backup_url_refused = not allowed
        self.backup_token = env("AV_BACKUP_TOKEN")
        register_literal_secret(self.backup_token)
        self.backup_tenant = tenant if _backup.TENANT_SEGMENT.fullmatch(tenant) else ""
        try:
            limit = int(env("AV_BACKUP_MAX_BYTES") or 0)
        except ValueError:
            limit = 0
        self.backup_max_bytes = limit if limit > 0 else _backup.DEFAULT_MAX_BYTES
        try:
            interval = float(env("AV_BACKUP_MIN_INTERVAL_S") or _backup.DEFAULT_MIN_INTERVAL_S)
        except ValueError:
            interval = _backup.DEFAULT_MIN_INTERVAL_S
        self.backup_min_interval_s = interval if math.isfinite(interval) and interval >= 0 else _backup.DEFAULT_MIN_INTERVAL_S

    @property
    def idle(self) -> bool:
        """No token means no wiring. Hooks stay registered and do nothing."""
        return not self.token

    @property
    def null_sink(self) -> bool:
        """Token but no URL: buffer to disk, never send. Dogfood before ingest."""
        return bool(self.token) and not self.url

    @property
    def active(self) -> bool:
        return self.enabled and not self.idle

    @property
    def backup_configured(self) -> bool:
        """Snapshots run only with a URL, a token and a usable tenant id, and
        never with the plugin switched off. They do not need `AV_EVENTS_TOKEN`:
        the backup is operational, and `memory.snapshot` is simply owed until
        events can be emitted (`_backup.run_once`)."""
        return (
            self.enabled
            and bool(self.backup_url)
            and bool(self.backup_token)
            and bool(self.backup_tenant)
            and "memory_snapshot" not in self.disabled_hooks
        )


# --------------------------------------------------------------------------
# Session state
# --------------------------------------------------------------------------


class SessionState:
    """Everything scoped to one session, the breaker included.

    The failure counter and the degraded flag live here rather than on the
    collector because the spec scopes them to a session and a Hermes process
    interleaves sessions freely — a subagent turn, a cron run and a Telegram
    conversation all pass through the same hooks. A counter shared across them
    is a counter that unrelated traffic can reset.
    """

    __slots__ = (
        "session_id",
        "source",
        "started_at",
        "started_emitted",
        "message_count",
        "tool_call_count",
        "input_tokens",
        "output_tokens",
        "pending_llm",
        "ended",
        "failure_count",
        "failures_by_hook",
        "degraded",
        "degraded_emitted",
        "hook_calls",
        "hook_overruns",
        "hook_max_ms",
        "slowest_hook",
    )

    def __init__(self, session_id: str, source: Optional[str] = None) -> None:
        self.session_id = session_id
        #: None until a hook carrying `platform` arrives — not "unknown", which
        #: would latch and stop the later `on_session_start` from correcting it.
        self.source: Optional[str] = source
        self.started_at = time.time()
        self.started_emitted = False
        self.message_count = 0
        self.tool_call_count = 0
        self.input_tokens = 0
        self.output_tokens = 0
        #: Hashes and request stamps left by pre_api_request for post to use.
        self.pending_llm: dict[str, dict] = {}
        self.ended = False
        self.failure_count = 0
        self.failures_by_hook: dict[str, int] = {}
        self.degraded = False
        self.degraded_emitted = False
        self.hook_calls = 0
        self.hook_overruns = 0
        self.hook_max_ms = 0.0
        self.slowest_hook: Optional[str] = None


# --------------------------------------------------------------------------
# Collector
# --------------------------------------------------------------------------


class Collector:
    """Owns config, buffer, flusher thread, counters and session bookkeeping.

    Every public method is safe to call from a hook: none of them raise, none of
    them touch the network, and none of them hold a lock longer than an append.
    """

    def __init__(self, config: Optional[Config] = None) -> None:
        self.config = config or Config()
        self.buffer: Optional[Buffer] = None
        self.sessions: "OrderedDict[str, SessionState]" = OrderedDict()
        #: Process-wide backstop, independent of any session.
        self.total_failures = 0
        #: Process-wide diagnostics, kept alongside the per-session stats that
        #: ride out on `session.ended`.
        self.overruns: dict[str, int] = {}
        self.max_hook_ms = 0.0
        self.plugin_disabled = False
        self._plugin_disabled_emitted = False
        self._seen: dict[str, str] = {}
        self._seen_loaded = False
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._backoff: dict[str, tuple[float, int]] = {}
        self._dropped: dict[str, Any] = {}
        self._atexit_registered = False
        #: Session ids that have already triggered a config reload, and when the
        #: last reload happened. Together these keep the env sweep off the hot
        #: path: one read per new session, plus a TTL for long-lived ones.
        self._config_seen: "OrderedDict[str, bool]" = OrderedDict()
        self._config_at = 0.0
        #: `plugin.degraded` events owed but not yet buffered, because the hook
        #: that tripped the breaker was one we must not do I/O in.
        self._pending_degraded: list[tuple[str, dict]] = []
        #: Delegated subagent session id -> the session that spawned it, from
        #: `subagent_start`. Memory only, bounded like the session table; it is
        #: where `parent_run_id` comes from (README "Intention capture").
        self._parents: "OrderedDict[str, str]" = OrderedDict()
        #: Intention events not emitted because an id failed the id pattern,
        #: by field. A count only: the offending value is never kept.
        self.intention_drops: dict[str, int] = {}
        #: EdgeOS actions awaiting a confirming read (`_edgeos.Ledger`),
        #: loaded from disk on first use.
        self.edgeos = Ledger()
        #: Cron executions already reported as `cron.run`.
        self._cron_cursor: Optional[CronCursor] = None
        self._cron_at = 0.0
        #: Cron-tail passes that raised. The tail runs on the flusher thread,
        #: outside `guarded`, so it keeps its own count.
        self.cron_errors = 0
        #: The tenant's HMAC key (`hash_key`), loaded on first use.
        self._hash_key: Optional[bytes] = None
        #: Diagnostic counters, names only (`tenant_id_not_uuid`, …).
        self.counters: dict[str, int] = {}
        self._check_tenant_id()
        #: Test seam. When set, used in place of `post_events`.
        self.sender: Optional[Callable[[str, str, list], SendResult]] = None
        #: Memory snapshot (`_backup`): a single-flight daemon thread, started
        #: by `request_snapshot` and gone when nothing is pending.
        self._backup_lock = threading.Lock()
        self._backup_pending = False
        #: The pending request may skip the rate limit (a finalize, or exit).
        self._backup_urgent = False
        #: Set by `_drain_backup`: run what is pending even though `_stop` is set.
        self._backup_final = False
        #: Wakes a thread waiting out the rate limit (a new urgent request, exit).
        self._backup_wake = threading.Event()
        #: monotonic start of the last pass, for `AV_BACKUP_MIN_INTERVAL_S`.
        self._backup_last: Optional[float] = None
        self._backup_thread: Optional[threading.Thread] = None
        #: monotonic time before which no upload is tried (after a 401/403).
        self.backup_blocked_until = 0.0
        #: Test seam. When set, used in place of `_backup.put_object`.
        self.backup_uploader: Optional[_backup.Uploader] = None

    # -- lifecycle --------------------------------------------------------

    def reload_config(self) -> None:
        """Re-read the kill switches."""
        self.config = Config()
        self._config_at = time.monotonic()
        self._check_tenant_id()

    def _check_tenant_id(self) -> None:
        """Count, and log once per process, a `TENANT_ID` that is not a UUID.

        Ingest recomputes `cron.run`'s id from the tenant id its token belongs
        to; a sandbox whose `TENANT_ID` is some other spelling of it has every
        `cron.run` quarantined as `event_id_mismatch`. The value is never logged.
        """
        tenant = self.config.tenant_id
        if not tenant:
            return
        try:
            uuid.UUID(tenant)
            return
        except ValueError:
            pass
        self.counters["tenant_id_not_uuid"] = self.counters.get("tenant_id_not_uuid", 0) + 1
        if "tenant_id_not_uuid" not in _LOGGED_COUNTERS:
            _LOGGED_COUNTERS.add("tenant_id_not_uuid")
            logger.warning("av-events: tenant_id_not_uuid=%d", self.counters["tenant_id_not_uuid"])

    def _ensure_buffer(self) -> Optional[Buffer]:
        if self.buffer is not None:
            return self.buffer
        try:
            self.buffer = Buffer(self.config.buffer_dir)
        except OSError:
            return None
        return self.buffer

    def _ensure_thread(self) -> None:
        """Start the flusher lazily, so an idle tenant runs no extra thread."""
        if self._thread is not None or self.config.idle:
            return
        thread = threading.Thread(target=self._loop, name="av-events-flush", daemon=True)
        self._thread = thread
        thread.start()
        self._register_atexit()

    def _register_atexit(self) -> None:
        if not self._atexit_registered:
            atexit.register(self.shutdown)
            self._atexit_registered = True

    def shutdown(self) -> None:
        """Best-effort final snapshot and flush. Bounded; the buffer survives on disk anyway.

        The snapshot goes first, so its `memory.snapshot` is in the buffer when
        the flush runs. Gateway shutdown finalizes open sessions
        (`gateway/run_shutdown.py`), which requests a snapshot on a daemon
        thread that would otherwise die with the process.
        """
        try:
            self._stop.set()
            self._wake.set()
            self._drain_backup()
            buffer = self.buffer
            if buffer is None:
                return
            buffer.rotate_if_due(force=True)
            if self.config.null_sink or not self.config.active:
                return
            deadline = time.time() + EXIT_FLUSH_BUDGET_S
            for path in buffer.ready_files():
                if time.time() >= deadline:
                    break
                self._send_file(path)
        except Exception:  # noqa: BLE001 - never raise out of atexit
            pass

    # -- emission ---------------------------------------------------------

    def envelope(self, event_type: str, payload: dict, **refs: Any) -> dict:
        """Envelope v1 (spec §3). Every field is always present.

        `evidence_class` is `agent_report` for everything this plugin emits: the
        plugin observes the agent, not the world. Ingest would downgrade
        anything stronger anyway (scenario 4).
        """
        stamp = now_iso()
        event = {
            # uuid v7 unless the caller derived one (`cron.run`, §4.3).
            "event_id": refs.pop("event_id", None) or uuid7(),
            "event_type": event_type,
            "schema_version": SCHEMA_VERSION,
            "occurred_at": refs.pop("occurred_at", None) or stamp,
            "occurred_at_earliest": refs.pop("occurred_at_earliest", None),
            "occurred_at_latest": refs.pop("occurred_at_latest", None),
            "emitted_at": stamp,
            "actor": refs.pop("actor", "agent"),
            "session_id": refs.pop("session_id", None),
            "turn_id": refs.pop("turn_id", None),
            "run_id": refs.pop("run_id", None),
            "parent_run_id": refs.pop("parent_run_id", None),
            "tool_call_id": refs.pop("tool_call_id", None),
            "intention_id": refs.pop("intention_id", None),
            "opportunity_id": refs.pop("opportunity_id", None),
            "decision_id": refs.pop("decision_id", None),
            "action_id": refs.pop("action_id", None),
            "outcome_id": refs.pop("outcome_id", None),
            "in_reply_to_event_id": refs.pop("in_reply_to_event_id", None),
            # `agent_report`, except the one claim a checkable receipt earns
            # (`action.receipted`, §2.1's receipt allowance).
            "evidence_class": refs.pop("evidence_class", None) or EVIDENCE_CLASS,
            "model_id": refs.pop("model_id", None),
            "prompt_version": refs.pop("prompt_version", None),
            "skill_version": refs.pop("skill_version", None),
            "overlay_ref": overlay_ref(),
            "hermes_version": hermes_version(),
            "policy_version": refs.pop("policy_version", None),
            "supersedes_event_id": refs.pop("supersedes_event_id", None),
            "payload": payload,
        }
        return event

    def emit(self, event_type: str, payload: dict, **refs: Any) -> Optional[dict]:
        """Build, sanitise and buffer one event. Returns it, or None if inert.

        Local and synchronous: a JSON dump and one appended line. No network.
        """
        if self.plugin_disabled or not self.config.active:
            return None
        buffer = self._ensure_buffer()
        if buffer is None:
            return None
        event = self.envelope(event_type, sanitize(payload), **refs)
        buffer.append(event)
        self._ensure_thread()
        return event

    # -- sessions ---------------------------------------------------------

    def begin(self, session_id: Optional[str]) -> None:
        """Session boundary: re-read the kill switches.

        This is what makes `AV_EVENTS_ENABLED=0` reversible without a restart
        (scenario 26) — the flag that disabled the plugin is also the flag being
        re-read. It reloads once per session id ever seen, plus a `CONFIG_TTL_S`
        refresh so a single long-lived session still notices a flip, and it does
        **not** touch any failure counter: those are per session now.
        """
        if self.plugin_disabled:
            return
        if session_id:
            if session_id in self._config_seen:
                if (time.monotonic() - self._config_at) < CONFIG_TTL_S:
                    return
            else:
                with self._lock:
                    self._config_seen[session_id] = True
                    while len(self._config_seen) > MAX_TRACKED_SESSIONS:
                        self._config_seen.popitem(last=False)
        elif (time.monotonic() - self._config_at) < CONFIG_TTL_S:
            return
        with self._lock:
            self.reload_config()

    def note_parent(self, child_session_id: Any, parent_session_id: Any) -> None:
        """Remember which session delegated to a subagent. Pure memory."""
        if not child_session_id or not parent_session_id:
            return
        child, parent = str(child_session_id), str(parent_session_id)
        if child == parent:
            return
        with self._lock:
            self._parents[child] = parent
            self._parents.move_to_end(child)
            while len(self._parents) > MAX_TRACKED_SESSIONS:
                self._parents.popitem(last=False)

    def count_intention_drop(self, field: str, count: int = 1) -> None:
        """Count intention events dropped for a malformed id. Pure memory."""
        with self._lock:
            self.intention_drops[field] = self.intention_drops.get(field, 0) + count

    def parent_of(self, session_id: Optional[str]) -> Optional[str]:
        """The session that delegated to `session_id`, or None if it was not a subagent."""
        if not session_id:
            return None
        return self._parents.get(session_id)

    def peek_session(self, session_id: Optional[str]) -> Optional[SessionState]:
        """The in-memory state for a session, or None. Never creates, never I/O."""
        if not session_id:
            return None
        return self.sessions.get(session_id)

    def open_session(self, session_id: str, source: Optional[str] = None) -> Optional[SessionState]:
        """Get or create the session, emitting `session.started` once a source is known.

        The emit is deferred until some hook supplies a `platform`, because the
        first hook to mention a session often does not carry one, and a `source`
        of "unknown" written at that moment would latch: `on_session_start`
        arrives later and could no longer correct it. `session_ended` forces the
        emit if the source never turned up.
        """
        with self._lock:
            state = self.sessions.get(session_id)
            if state is None:
                state = SessionState(session_id, source)
                self.sessions[session_id] = state
                while len(self.sessions) > MAX_TRACKED_SESSIONS:
                    self.sessions.popitem(last=False)
            elif source and state.source is None:
                state.source = source
        self._emit_started(state)
        return state

    def _emit_started(self, state: SessionState, force: bool = False) -> None:
        if state.started_emitted or (state.source is None and not force):
            return
        with self._lock:
            if state.started_emitted:
                return
            state.started_emitted = True
        self.emit(
            "session.started",
            {"source": state.source or "unknown", "cron_job_id": cron_job_id_from(state.session_id)},
            session_id=state.session_id,
        )

    def session_ended(self, session_id: str, **extra: Any) -> None:
        with self._lock:
            state = self.sessions.get(session_id)
            if state is None or state.ended:
                return
            state.ended = True
        # A session that never learned its source still gets a start event, so
        # the pair is always well formed for the funnel.
        self._emit_started(state, force=True)
        self._drain_pending_degraded()
        payload: dict[str, Any] = {
            "source": state.source or "unknown",
            "message_count": state.message_count,
            "tool_call_count": state.tool_call_count,
            "input_tokens": state.input_tokens,
            "output_tokens": state.output_tokens,
            "duration_ms": int((time.time() - state.started_at) * 1000),
            # The data behind the guardrails p95 gate. Without these the 50 ms
            # budget is measured and then thrown away.
            "hook_calls": state.hook_calls,
            "hook_failures": state.failure_count,
            "hook_overruns": state.hook_overruns,
            "hook_max_ms": round(state.hook_max_ms, 3),
            "slowest_hook": state.slowest_hook,
            "degraded": state.degraded,
            "cron_job_id": extra.get("cron_job_id") or cron_job_id_from(session_id),
            # §4.1 `actual_cost_usd?`, `cost_source?`, from Hermes's own
            # `state.db` row for the session (`read_session_cost`). Hermes's
            # estimate rides beside it and is never promoted to "actual".
            "actual_cost_usd": extra.get("actual_cost_usd"),
            "cost_source": extra.get("cost_source"),
            "estimated_cost_usd": extra.get("estimated_cost_usd"),
            "cost_status": extra.get("cost_status"),
        }
        self.emit("session.ended", payload, session_id=session_id)
        with self._lock:
            self.sessions.pop(session_id, None)
        # Wake the flusher rather than sending inline: a hook never blocks on
        # the network (guardrails §2). atexit does the synchronous last pass.
        buffer = self.buffer
        if buffer is not None:
            buffer.rotate_if_due(force=True)
        self._wake.set()

    # -- memory snapshot (DATA-82) -----------------------------------------

    def count(self, name: str, n: int = 1) -> None:
        """Bump a diagnostic counter, and log it once per process as a name and
        a count. Never the value or the path that tripped it."""
        with self._lock:
            self.counters[name] = self.counters.get(name, 0) + n
            value = self.counters[name]
            first = name not in _LOGGED_COUNTERS
            _LOGGED_COUNTERS.add(name)
        if first and name != "backup_uploaded":
            logger.warning("av-events: %s=%d", name, value)

    def request_snapshot(self, urgent: bool = False) -> bool:
        """Ask for a memory snapshot. Returns at once; never I/O, never raises.

        Called from `on_session_end` (every turn) and `on_session_finalize`
        (`urgent`). Collecting, compressing and uploading all happen on a
        single-flight daemon thread: a request while a pass is running or
        waiting sets a flag, and that thread runs one more pass, so the last
        turn is always captured and there is never more than one snapshot
        thread. A turn's request waits out `AV_BACKUP_MIN_INTERVAL_S` since the
        last pass began; a finalize's does not.
        """
        try:
            if self.plugin_disabled:
                return False
            if self.config.backup_url_refused:
                self.count("backup_url_refused")
                return False
            if not self.config.backup_configured:
                return False
            with self._backup_lock:
                self._backup_pending = True
                if urgent:
                    self._backup_urgent = True
                self._backup_wake.set()
                if self._backup_thread is not None and self._backup_thread.is_alive():
                    return True
                self._start_backup_thread()
            self._register_atexit()
            return True
        except Exception:  # noqa: BLE001 - a snapshot never costs the hook anything
            self.count("backup_error")
            return False

    def _start_backup_thread(self) -> threading.Thread:
        """Under `_backup_lock`. May raise (no threads at interpreter shutdown, 3.12+)."""
        thread = threading.Thread(target=self._backup_loop, name="av-events-backup", daemon=True)
        self._backup_thread = thread
        thread.start()
        return thread

    def _backup_loop(self) -> None:
        while True:
            with self._backup_lock:
                stopping = self._stop.is_set() and not self._backup_final
                if not self._backup_pending or stopping:
                    if self._backup_thread is threading.current_thread():
                        self._backup_thread = None
                    return
                wait = 0.0
                if not (self._backup_urgent or self._backup_final) and self._backup_last is not None:
                    wait = self._backup_last + self.config.backup_min_interval_s - time.monotonic()
                self._backup_wake.clear()
                if wait <= 0:
                    self._backup_pending = False
                    self._backup_urgent = False
                    self._backup_last = time.monotonic()
            if wait > 0:
                # Woken early by an urgent request or by exit; either way the
                # loop re-reads the flags.
                self._backup_wake.wait(wait)
                continue
            self.snapshot_once()

    def snapshot_once(self, now: Optional[float] = None, timeout: float = _backup.UPLOAD_TIMEOUT_S) -> str:
        """One snapshot pass (`_backup.run_once`). Tests call it directly."""
        if self.plugin_disabled:
            return "disabled"
        return _backup.run_once(self, now, timeout)

    def _drain_backup(self, budget: Optional[float] = None) -> None:
        """At exit: give a pending or running snapshot at most `budget` seconds.

        The pass runs on the backup thread, never on the exiting one, and this
        only joins it for what is left of the budget: an upload that hangs
        costs the exit `budget`, not the upload's own timeout. A pending
        request with no thread gets one if the interpreter still allows it
        (3.12+ refuses new threads at shutdown; then the snapshot is skipped,
        counted as `backup_exit_skipped`). Periodic turn-end passes are what
        make the backup current; this is the last chance, not the mechanism.
        """
        try:
            deadline = time.monotonic() + (_backup.EXIT_BUDGET_S if budget is None else budget)
            with self._backup_lock:
                self._backup_final = True
                self._backup_wake.set()
                thread = self._backup_thread
                if thread is None or not thread.is_alive():
                    if not self._backup_pending:
                        return
                    try:
                        thread = self._start_backup_thread()
                    except Exception:  # noqa: BLE001 - RuntimeError at shutdown
                        self.count("backup_exit_skipped")
                        return
            thread.join(max(0.0, deadline - time.monotonic()))
        except Exception:  # noqa: BLE001 - never raise out of atexit
            pass

    def nudge_flush(self) -> None:
        """Ask the flusher to run now. Returns immediately; never sends inline."""
        self._drain_pending_degraded()
        buffer = self.buffer
        if buffer is not None:
            buffer.rotate_if_due()
        self._wake.set()

    # -- host stores: cost, profile, EdgeOS ledger, cron tail -------------
    #
    # Every read here is of a store Hermes owns, opened read-only, bounded, and
    # "no data" on any failure. None of it is reachable from `pre_tool_call`.

    def _read_json(self, path: str) -> Any:
        try:
            with open(path, encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return None

    def _write_json(self, path: str, data: Any) -> None:
        tmp = f"{path}.{os.getpid()}.tmp"
        try:
            os.makedirs(os.path.dirname(path), mode=DIR_MODE, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, separators=(",", ":"))
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def read_session_cost(self, session_id: str) -> dict:
        """Hermes's cost columns for one session from `$HERMES_HOME/state.db`.

        `sessions.actual_cost_usd`, `estimated_cost_usd`, `cost_status`,
        `cost_source` (`hermes_state.py` at `v2026.8.31`). Read-only, with a
        short lock timeout: a busy database costs this session its cost figure,
        never the hook its budget. Nothing is read while the plugin is inert.
        """
        if self.plugin_disabled or not self.config.active:
            return {}
        rows = sqlite_read(
            os.path.join(self.config.home, "state.db"),
            "SELECT actual_cost_usd, estimated_cost_usd, cost_status, cost_source FROM sessions WHERE id = ?",
            (session_id,),
            timeout=0.05,
        )
        if not rows:
            return {}
        row = rows[0]

        def usd(value: Any) -> Optional[float]:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            return float(value) if math.isfinite(value) and value >= 0 else None

        def label(value: Any) -> Optional[str]:
            return value if isinstance(value, str) and _COST_LABEL.match(value) else None

        return {
            "actual_cost_usd": usd(row.get("actual_cost_usd")),
            "estimated_cost_usd": usd(row.get("estimated_cost_usd")),
            "cost_status": label(row.get("cost_status")),
            "cost_source": label(row.get("cost_source")),
        }

    def check_profile(self, session_id: Optional[str]) -> list[dict]:
        """Emit `profile.updated` for each USER.md that has changed.

        Two files, told apart by `kind` (`PROFILE_FILES`): `memory_profile` is
        `$HERMES_HOME/memories/USER.md`, what the agent's memory tool keeps;
        `landing_profile` is `$HERMES_HOME/USER.md`, what the landing's
        enrichment wrote. §4.1 `user_md_hash`, `length`. The hash is the keyed
        HMAC (`keyed_hash_bytes`) of the file's bytes — a short, templated
        USER.md is guessable from a plain SHA-256 — and rides in every mode:
        `core.tasks` keys on it, within the tenant. Without a key nothing is
        emitted or recorded, and the next session end tries again. `length`
        counts characters and is omitted in `metadata`. The last hash sent per kind is kept in
        `$HERMES_HOME/av-events/profile.json` and recorded only after the event
        is buffered, so an inert emit is retried at the next session end.
        """
        if self.plugin_disabled or not self.config.active:
            return []
        state_path = os.path.join(self.config.state_dir, "profile.json")
        kinds = {kind for kind, _ in PROFILE_FILES}
        emitted: list[dict] = []
        # Two sessions can finalize at once; one of them reports the change.
        with self._lock:
            previous = self._read_json(state_path)
            seen = {k: v for k, v in previous.items() if isinstance(v, str)} if isinstance(previous, dict) else {}
            changed = False
            for kind, parts in PROFILE_FILES:
                path = os.path.join(self.config.home, *parts)
                try:
                    if os.path.getsize(path) > MAX_PROFILE_BYTES:
                        continue
                    with open(path, "rb") as handle:
                        raw = handle.read(MAX_PROFILE_BYTES + 1)
                except OSError:
                    continue
                digest = self.keyed_hash_bytes(raw)
                if digest is None or seen.get(kind) == digest:
                    continue
                payload: dict[str, Any] = {"kind": kind, "user_md_hash": digest}
                if self.config.capture != "metadata":
                    payload["length"] = len(raw.decode("utf-8", errors="replace"))
                event = self.emit("profile.updated", payload, session_id=session_id)
                if event is not None:
                    seen[kind] = digest
                    changed = True
                    emitted.append(event)
            if changed:
                self._write_json(state_path, {k: v for k, v in seen.items() if k in kinds})
        return emitted

    def hash_key(self) -> Optional[bytes]:
        """The tenant's HMAC key (`load_or_create_key`), cached for the process.

        None when it cannot be read or created; then nothing keyed is emitted
        (null, never a plain hash in its place) and `hash_key_unavailable` is
        counted. A failure is not cached, so a later hook can still succeed.
        """
        if self._hash_key is not None:
            return self._hash_key
        key = load_or_create_key(self.config.state_dir, self.counters)
        if key is None:
            self.counters["hash_key_unavailable"] = self.counters.get("hash_key_unavailable", 0) + 1
            return None
        self._hash_key = key
        return key

    def keyed_hash(self, text: str) -> Optional[str]:
        """HMAC-SHA256 of `text` under the tenant's key, or None without a key.

        For values that are not join keys across producers — message text, tool
        arguments and results, a `metadata`-mode EdgeOS event id — a plain
        SHA-256 of a few words is a dictionary lookup away from the words. The
        key never leaves the sandbox, so the digest is useful only for counting
        and joining within this tenant.
        """
        key = self.hash_key()
        if key is None:
            return None
        return hmac.new(key, text.encode("utf-8", errors="surrogatepass"), hashlib.sha256).hexdigest()

    def keyed_hash_bytes(self, raw: bytes) -> Optional[str]:
        """`keyed_hash` over bytes as they are on disk."""
        key = self.hash_key()
        if key is None:
            return None
        return hmac.new(key, raw, hashlib.sha256).hexdigest()

    def edgeos_ledger(self) -> Ledger:
        self.edgeos.load(os.path.join(self.config.state_dir, "edgeos_actions.json"))
        return self.edgeos

    def save_edgeos_ledger(self) -> None:
        self.edgeos.save(os.path.join(self.config.state_dir, "edgeos_actions.json"))

    def cron_tick(self, now: Optional[float] = None) -> int:
        """Emit `cron.run` for every newly finished cron execution. Flusher thread only.

        The event id is §4.3's `uuid5(NS_AV, "{tenant}|cron|{execution_id}")`
        when the tenant id is known, so a re-read, a second process tailing the
        same ledger or a lost cursor all produce the same id and ingest keeps
        one row. Without a tenant id it falls back to a uuid v7 and the cursor
        file is the only dedupe.
        """
        if self.plugin_disabled or not self.config.active or "cron_run" in self.config.disabled_hooks:
            return 0
        try:
            now = time.time() if now is None else now
            cursor = self._cron_cursor
            if cursor is None or cursor.path != os.path.join(self.config.state_dir, "cron_cursor.json"):
                cursor = self._cron_cursor = CronCursor(os.path.join(self.config.state_dir, "cron_cursor.json"))
            cursor.load(self._read_json)
            emitted = 0
            for payload in pending_runs(self.config.home, cursor, now):
                execution_id = payload["execution_id"]
                finished = payload["finished_at"]
                event = self.emit(
                    "cron.run",
                    payload,
                    event_id=cron_run_event_id(self.config.tenant_id, execution_id) if self.config.tenant_id else None,
                    occurred_at=finished,
                    occurred_at_earliest=payload["started_at"] or payload["claimed_at"],
                    occurred_at_latest=finished,
                    actor="system",
                    # Hermes's task id for the run, so `cron.run` joins the
                    # run's own `llm.call` / `tool.call` rows on `run_id`.
                    run_id=f"cron:{payload['job_id']}:{execution_id}",
                )
                if event is None:
                    break
                cursor.add(execution_id)
                emitted += 1
            if emitted:
                self._write_json(cursor.path, cursor.snapshot())
            return emitted
        except Exception:  # noqa: BLE001 - the tail must never take the flusher down
            self.cron_errors += 1
            return 0

    # -- failures ---------------------------------------------------------

    def record_stats(self, hook: str, session_id: Optional[str], elapsed_ms: float) -> None:
        """Fold one hook call into its session's stats. Pure memory.

        Also kept process-wide, because a hook that overruns before its session
        is open has no `session.ended` to be reported on, and that is precisely
        the call worth knowing about.
        """
        try:
            over = elapsed_ms > HOOK_BUDGET_MS
            if over:
                self.overruns[hook] = self.overruns.get(hook, 0) + 1
            if elapsed_ms > self.max_hook_ms:
                self.max_hook_ms = elapsed_ms
            state = self.peek_session(session_id)
            if state is None:
                return
            state.hook_calls += 1
            if over:
                state.hook_overruns += 1
            if elapsed_ms > state.hook_max_ms:
                state.hook_max_ms = elapsed_ms
                state.slowest_hook = hook
        except Exception:  # noqa: BLE001
            pass

    def record_failure(
        self, hook: str, exc: BaseException, session_id: Optional[str] = None, defer_emit: bool = False
    ) -> None:
        """Count a failure against its session, and against the process.

        `defer_emit` is for hooks we must not do I/O in — `pre_tool_call` fails
        closed in Hermes, so buffering a file from it could block a tool call.
        The event is queued and written by the next hook that is allowed to.
        """
        try:
            payload: Optional[dict] = None
            with self._lock:
                self.total_failures += 1
                state = self.sessions.get(session_id) if session_id else None
                if state is None and session_id:
                    # A hook that throws before it opens the session is exactly
                    # the case the breaker exists for, so give the failure
                    # somewhere to land. Pure memory: a state with no source
                    # emits nothing until something tells it one.
                    state = SessionState(session_id)
                    self.sessions[session_id] = state
                    while len(self.sessions) > MAX_TRACKED_SESSIONS:
                        self.sessions.popitem(last=False)
                if state is None:
                    tripped_session = False
                else:
                    if not state.degraded:
                        state.failure_count += 1
                        state.failures_by_hook[hook] = state.failures_by_hook.get(hook, 0) + 1
                    tripped_session = (
                        state.failure_count >= MAX_SESSION_FAILURES and not state.degraded_emitted
                    )
                    if tripped_session:
                        state.degraded_emitted = True
                        state.degraded = True
                        payload = {
                            "hook": hook,
                            "scope": "session",
                            "error_count": state.failure_count,
                            "errors_by_hook": dict(state.failures_by_hook),
                            "hermes_version": hermes_version(),
                            # Class name only: an exception message can carry
                            # the prompt or tool argument that caused it.
                            "last_error": type(exc).__name__,
                        }

                tripped_process = (
                    self.total_failures >= MAX_PROCESS_FAILURES and not self._plugin_disabled_emitted
                )
                if tripped_process:
                    self._plugin_disabled_emitted = True
                    payload = {
                        "hook": hook,
                        "scope": "process",
                        "error_count": self.total_failures,
                        "hermes_version": hermes_version(),
                        "last_error": type(exc).__name__,
                    }

            if payload is None:
                return
            if defer_emit:
                with self._lock:
                    self._pending_degraded.append(("plugin.degraded", payload))
                    if session_id:
                        self._pending_degraded[-1][1].setdefault("session_id", session_id)
            else:
                self.emit("plugin.degraded", payload, session_id=session_id)
            if payload.get("scope") == "process":
                # Set last: the event above must still be allowed through.
                self.plugin_disabled = True
        except Exception:  # noqa: BLE001 - the failure path may not fail
            pass

    def _drain_pending_degraded(self) -> None:
        """Write any `plugin.degraded` owed from a hook that could not do I/O."""
        try:
            with self._lock:
                pending, self._pending_degraded = self._pending_degraded, []
            for event_type, payload in pending:
                self.emit(event_type, payload, session_id=payload.pop("session_id", None))
        except Exception:  # noqa: BLE001
            pass

    def hook_allowed(self, hook: str, session_id: Optional[str] = None) -> bool:
        if self.plugin_disabled or not self.config.enabled:
            return False
        if hook.lower() in self.config.disabled_hooks:
            return False
        state = self.peek_session(session_id)
        return not (state is not None and state.degraded)

    # -- content-addressed prompt registry --------------------------------

    def _seen_path(self) -> str:
        return os.path.join(self.config.state_dir, "seen.json")

    def _load_seen(self) -> dict:
        if self._seen_loaded:
            return self._seen
        self._seen_loaded = True
        try:
            with open(self._seen_path(), encoding="utf-8") as handle:
                parsed = json.load(handle)
            hashes = parsed.get("hashes") if isinstance(parsed, dict) else None
            if isinstance(hashes, dict):
                self._seen = {str(k): str(v) for k, v in hashes.items()}
        except (OSError, json.JSONDecodeError, ValueError, AttributeError):
            self._seen = {}
        return self._seen

    def _save_seen(self) -> None:
        path = self._seen_path()
        tmp = f"{path}.{os.getpid()}.tmp"
        try:
            os.makedirs(self.config.state_dir, mode=DIR_MODE, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"hashes": self._seen}, handle, separators=(",", ":"))
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def register_prompt(self, kind: str, digest: str, body: Any, **refs: Any) -> Optional[dict]:
        """Emit `prompt.registered` once per hash, ever, for this instance.

        `full` capture only. The seen-set lives on disk, so a second session
        with the same tool schemas emits nothing.
        """
        if self.config.capture != "full" or not digest:
            return None
        with self._lock:
            if digest in self._load_seen():
                return None
        # Emit *before* recording the hash. Marking it seen first means that an
        # emit which turns out to be inert — no token yet, plugin disabled, an
        # unwritable buffer — loses the body permanently, while every later
        # `llm.call` still carries the hash. An orphaned hash is worse than a
        # duplicate `prompt.registered`, which ingest deduplicates anyway.
        event = self.emit("prompt.registered", {"hash": digest, "kind": kind, "body": body}, **refs)
        if event is None:
            return None
        with self._lock:
            self._seen[digest] = kind
            self._save_seen()
        return event

    # -- flusher ----------------------------------------------------------

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(TICK_INTERVAL_S)
            self._wake.clear()
            if self._stop.is_set():
                return
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the flusher never dies
                pass
            if time.monotonic() - self._cron_at >= CRON_POLL_INTERVAL_S:
                self._cron_at = time.monotonic()
                self.cron_tick()

    def tick(self) -> None:
        """One flush pass. Runs on the flusher thread; tests call it directly."""
        buffer = self.buffer
        if buffer is None:
            return
        buffer.rotate_if_due()
        if self.config.null_sink or not self.config.url or not self.config.token:
            # Null sink: batches accumulate on disk and are never sent, and are
            # never aged out either. There is no destination to retry against,
            # so dropping them would only destroy the dogfood evidence.
            return
        now = time.time()
        attempted = 0
        for path in buffer.ready_files():
            # A large backlog must not turn one tick into a long blocking walk;
            # the rest are picked up on the next pass a second later.
            if attempted >= MAX_FILES_PER_TICK:
                break
            name = os.path.basename(path)
            next_at, attempts = self._backoff.get(name, (0.0, 0))
            if now < next_at:
                continue
            age = now - (Buffer.file_started_ms(path) / 1000.0)
            if age > MAX_BUFFER_AGE_S:
                self._discard_file(path, "expired")
                continue
            attempted += 1
            ok, retryable = self._send_file(path)
            if ok:
                self._backoff.pop(name, None)
            elif not retryable:
                # Ingest will never accept this batch. Quarantine it so the
                # queue behind it drains, and keep it on disk to look at.
                self._discard_file(path, "rejected")
            else:
                delay = min(BACKOFF_BASE_S * (2**attempts), BACKOFF_MAX_S)
                self._backoff[name] = (time.time() + delay, attempts + 1)

    def _send_file(self, path: str) -> tuple[bool, bool]:
        """Returns (delivered, retryable)."""
        events = Buffer.read_events(path)
        if not events:
            try:
                os.unlink(path)
            except OSError:
                pass
            return True, True
        sender = self.sender or post_events
        result = sender(self.config.url, self.config.token, events)
        if not result.ok:
            return False, result.retryable
        try:
            os.unlink(path)
        except OSError:
            pass
        self._emit_drop_report()
        return True, True

    def _discard_file(self, path: str, reason: str) -> None:
        """Take a batch out of the send queue for good.

        `expired`: past 72 h it is evidence of an outage, not of a session, and
        it is deleted. `rejected`: ingest refused it outright, so it is moved to
        `buffer/rejected/` and kept — a 401 or a 413 is something a human needs
        to see, and deleting the evidence of a misconfiguration would hide it.
        """
        events = Buffer.read_events(path)
        stamps = sorted(str(e.get("emitted_at")) for e in events if e.get("emitted_at"))
        buffer = self.buffer
        if reason == "rejected" and buffer is not None:
            if not buffer.reject(path):
                return
        else:
            try:
                os.unlink(path)
            except OSError:
                return
        self._backoff.pop(os.path.basename(path), None)
        record = self._dropped
        record["count"] = int(record.get("count", 0)) + len(events)
        if reason == "rejected":
            record["rejected_files"] = int(record.get("rejected_files", 0)) + 1
            record["rejected_events"] = int(record.get("rejected_events", 0)) + len(events)
        else:
            record["files"] = int(record.get("files", 0)) + 1
        reasons = set(record.get("reasons") or ())
        reasons.add(reason)
        record["reasons"] = sorted(reasons)
        if stamps:
            oldest = record.get("oldest_event_at")
            newest = record.get("newest_event_at")
            record["oldest_event_at"] = min(oldest, stamps[0]) if oldest else stamps[0]
            record["newest_event_at"] = max(newest, stamps[-1]) if newest else stamps[-1]

    def _emit_drop_report(self) -> None:
        """One `plugin.buffer_dropped` on the first flush that succeeds after a loss."""
        if not self._dropped:
            return
        payload = dict(self._dropped)
        reasons = payload.pop("reasons", []) or []
        payload["reason"] = "+".join(reasons) if reasons else "expired"
        payload.setdefault("files", 0)
        payload.setdefault("rejected_files", 0)
        payload.setdefault("rejected_events", 0)
        payload.setdefault("oldest_event_at", None)
        payload.setdefault("newest_event_at", None)
        payload["hook"] = "buffer"
        payload["hermes_version"] = hermes_version()
        self._dropped = {}
        self.emit("plugin.buffer_dropped", payload)


# --------------------------------------------------------------------------
# Fail-open decorator
# --------------------------------------------------------------------------


def guarded(
    hook: str,
    collector_ref: Callable[[], Optional[Collector]],
    *,
    quiet: bool = False,
) -> Callable:
    """Wrap a hook body so nothing it does can reach Hermes.

    Catches `BaseException` deliberately: a `MemoryError` raised inside our hook
    must not take the turn loop with it either. `SystemExit` is re-raised,
    because swallowing a shutdown would be worse than losing an event.

    `quiet=True` marks a hook that must perform no I/O at all — Hermes fails
    *closed* on `pre_tool_call`, so a config reload or a buffer write there can
    stall a tool call. A quiet hook skips the config refresh and queues any
    `plugin.degraded` for the next hook that is allowed to write it.

    The wrapped function is called as `fn(collector, *args, **kwargs)`.
    """

    def decorate(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> None:
            collector = collector_ref()
            if collector is None:
                return None
            session_id = kwargs.get("session_id") or kwargs.get("parent_session_id")
            if not quiet:
                try:
                    collector.begin(session_id)
                except Exception:  # noqa: BLE001 - a reload must not break a hook
                    pass
            if not collector.hook_allowed(hook, session_id):
                return None
            start = time.perf_counter()
            try:
                fn(collector, *args, **kwargs)
            except SystemExit:
                raise
            except BaseException as exc:  # noqa: BLE001 - the whole point
                collector.record_failure(hook, exc, session_id, defer_emit=quiet)
            finally:
                collector.record_stats(hook, session_id, (time.perf_counter() - start) * 1000.0)
            return None

        wrapper.av_hook_name = hook  # type: ignore[attr-defined]
        return wrapper

    return decorate


__all__ = [
    "Collector",
    "Config",
    "SessionState",
    "guarded",
    "hermes_version",
    "overlay_ref",
    "reset_runtime_cache",
    "FLUSH_INTERVAL_S",
    "MAX_SESSION_FAILURES",
]
