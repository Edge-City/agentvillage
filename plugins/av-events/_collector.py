"""Config, session bookkeeping, the buffer flusher and the fail-open decorator.

`_core` holds the primitives; this module holds the state machine. `__init__`
holds `register(ctx)` and the hook adapters, and is the only module that knows
anything about Hermes.
"""

from __future__ import annotations

import atexit
import functools
import json
import os
import threading
import time
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
    env,
    env_flag_disabled,
    hermes_home,
    now_iso,
    post_events,
    register_literal_secret,
    sanitize,
    uuid7,
)

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

    __slots__ = ("enabled", "url", "token", "capture", "disabled_hooks", "home", "buffer_dir", "state_dir")

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
        register_literal_secret(self.token)

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
        "intention_calls",
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
        #: `tool_call_id`s that already produced an intention event, so a
        #: post-tool hook that fires twice for one call cannot record the
        #: intention twice. Bounded; see `MAX_INTENTION_CALLS`.
        self.intention_calls: "OrderedDict[str, bool]" = OrderedDict()
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
        #: Test seam. When set, used in place of `post_events`.
        self.sender: Optional[Callable[[str, str, list], SendResult]] = None

    # -- lifecycle --------------------------------------------------------

    def reload_config(self) -> None:
        """Re-read the kill switches."""
        self.config = Config()
        self._config_at = time.monotonic()

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
        if not self._atexit_registered:
            atexit.register(self.shutdown)
            self._atexit_registered = True

    def shutdown(self) -> None:
        """Best-effort final flush. Bounded; the buffer survives on disk anyway."""
        try:
            self._stop.set()
            self._wake.set()
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
            "event_id": uuid7(),
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
            "evidence_class": EVIDENCE_CLASS,
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
        self.emit("session.started", {"source": state.source or "unknown"}, session_id=state.session_id)

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
        }
        if extra.get("cron_job_id"):
            payload["cron_job_id"] = extra["cron_job_id"]
        self.emit("session.ended", payload, session_id=session_id)
        with self._lock:
            self.sessions.pop(session_id, None)
        # Wake the flusher rather than sending inline: a hook never blocks on
        # the network (guardrails §2). atexit does the synchronous last pass.
        buffer = self.buffer
        if buffer is not None:
            buffer.rotate_if_due(force=True)
        self._wake.set()

    def nudge_flush(self) -> None:
        """Ask the flusher to run now. Returns immediately; never sends inline."""
        self._drain_pending_degraded()
        buffer = self.buffer
        if buffer is not None:
            buffer.rotate_if_due()
        self._wake.set()

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
