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
from typing import Any, Callable, Optional

from ._core import (
    BACKOFF_BASE_S,
    BACKOFF_MAX_S,
    CAPTURE_MODES,
    DEFAULT_CAPTURE,
    EVIDENCE_CLASS,
    EXIT_FLUSH_BUDGET_S,
    FLUSH_INTERVAL_S,
    HOOK_BUDGET_MS,
    MAX_BUFFER_AGE_S,
    MAX_SESSION_FAILURES,
    SCHEMA_VERSION,
    TICK_INTERVAL_S,
    Buffer,
    SendResult,
    env,
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
        self.enabled = env("AV_EVENTS_ENABLED") != "0"
        self.url = env("AV_EVENTS_URL").rstrip("/")
        self.token = env("AV_EVENTS_TOKEN")
        capture = env("AV_CAPTURE").lower() or DEFAULT_CAPTURE
        self.capture = capture if capture in CAPTURE_MODES else DEFAULT_CAPTURE
        self.disabled_hooks = frozenset(
            part.strip() for part in env("AV_HOOKS_DISABLED").split(",") if part.strip()
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
    __slots__ = (
        "session_id",
        "source",
        "started_at",
        "message_count",
        "tool_call_count",
        "input_tokens",
        "output_tokens",
        "pending_llm",
        "ended",
    )

    def __init__(self, session_id: str, source: str) -> None:
        self.session_id = session_id
        self.source = source
        self.started_at = time.time()
        self.message_count = 0
        self.tool_call_count = 0
        self.input_tokens = 0
        self.output_tokens = 0
        #: Hashes and a perf_counter stamp left by pre_llm_call for post to use.
        self.pending_llm: dict[str, dict] = {}
        self.ended = False


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
        self.sessions: dict[str, SessionState] = {}
        self.failure_count = 0
        self.failures_by_hook: dict[str, int] = {}
        self.overruns: dict[str, int] = {}
        self.degraded = False
        self._degraded_emitted = False
        self._seen: dict[str, str] = {}
        self._seen_loaded = False
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._backoff: dict[str, tuple[float, int]] = {}
        self._dropped: dict[str, Any] = {}
        self._atexit_registered = False
        self._config_session_id: Optional[str] = None
        #: Test seam. When set, used in place of `post_events`.
        self.sender: Optional[Callable[[str, str, list], SendResult]] = None

    # -- lifecycle --------------------------------------------------------

    def reload_config(self) -> None:
        """Re-read the kill switches. Called at every session start."""
        self.config = Config()

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
        if self.degraded or not self.config.active:
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
        """Session boundary: re-read the kill switches and clear the counters.

        Called before the enabled check on every hook, which is what makes
        `AV_EVENTS_ENABLED=0` reversible without a restart (scenario 26): the
        flag that disabled the plugin is also the flag being re-read. Bounded to
        one reload per session id, so it costs a dict compare on the hot path.
        """
        if not session_id or session_id == self._config_session_id:
            return
        with self._lock:
            if session_id == self._config_session_id:
                return
            self._config_session_id = session_id
            self.reload_config()
            self.failure_count = 0
            self.failures_by_hook = {}
            self.degraded = False
            self._degraded_emitted = False

    def session_started(self, session_id: str, source: str = "unknown", **extra: Any) -> Optional[SessionState]:
        """Idempotent. Re-reads the kill switches, then emits `session.started`.

        Callable from any hook, so a Hermes build with no session-start hook
        still produces the event on the session's first observed activity.
        """
        self.begin(session_id)
        with self._lock:
            existing = self.sessions.get(session_id)
            if existing is not None:
                return existing
            state = SessionState(session_id, source)
            self.sessions[session_id] = state
        payload: dict[str, Any] = {"source": source}
        if extra.get("cron_job_id"):
            payload["cron_job_id"] = extra["cron_job_id"]
        self.emit("session.started", payload, session_id=session_id)
        return state

    def session_ended(self, session_id: str, **extra: Any) -> None:
        with self._lock:
            state = self.sessions.get(session_id)
            if state is None or state.ended:
                return
            state.ended = True
        payload: dict[str, Any] = {
            "source": state.source,
            "message_count": state.message_count,
            "tool_call_count": state.tool_call_count,
            "input_tokens": state.input_tokens,
            "output_tokens": state.output_tokens,
            "duration_ms": int((time.time() - state.started_at) * 1000),
        }
        if extra.get("cron_job_id"):
            payload["cron_job_id"] = extra["cron_job_id"]
        self.emit("session.ended", payload, session_id=session_id)
        # Wake the flusher rather than sending inline: a hook never blocks on
        # the network (guardrails §2). atexit does the synchronous last pass.
        buffer = self.buffer
        if buffer is not None:
            buffer.rotate_if_due(force=True)
        self._wake.set()

    def nudge_flush(self) -> None:
        """Ask the flusher to run now. Returns immediately; never sends inline."""
        buffer = self.buffer
        if buffer is not None:
            buffer.rotate_if_due()
        self._wake.set()

    def state_for(self, session_id: Optional[str], source: str = "unknown") -> Optional[SessionState]:
        if not session_id:
            return None
        return self.session_started(session_id, source)

    # -- failures ---------------------------------------------------------

    def record_failure(self, hook: str, exc: BaseException) -> None:
        """Count a hook failure; trip the degraded switch at the tenth."""
        try:
            with self._lock:
                if self.degraded:
                    return
                self.failure_count += 1
                self.failures_by_hook[hook] = self.failures_by_hook.get(hook, 0) + 1
                count = self.failure_count
                tripped = count >= MAX_SESSION_FAILURES and not self._degraded_emitted
                if tripped:
                    self._degraded_emitted = True
                    by_hook = dict(self.failures_by_hook)
            if not tripped:
                return
            # Emit before disabling, so the one degraded event still goes out.
            self.emit(
                "plugin.degraded",
                {
                    "hook": hook,
                    "error_count": count,
                    "errors_by_hook": by_hook,
                    "hermes_version": hermes_version(),
                    "last_error": sanitize(f"{type(exc).__name__}: {exc}")[:200],
                },
            )
            with self._lock:
                self.degraded = True
        except Exception:  # noqa: BLE001 - the failure path may not fail
            pass

    def record_overrun(self, hook: str, elapsed_ms: float) -> None:
        try:
            with self._lock:
                self.overruns[hook] = self.overruns.get(hook, 0) + 1
        except Exception:  # noqa: BLE001
            pass

    def hook_allowed(self, hook: str) -> bool:
        return not self.degraded and self.config.enabled and hook not in self.config.disabled_hooks

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
            os.makedirs(self.config.state_dir, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as handle:
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
            seen = self._load_seen()
            if digest in seen:
                return None
            seen[digest] = kind
            self._save_seen()
        return self.emit("prompt.registered", {"hash": digest, "kind": kind, "body": body}, **refs)

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
        for path in buffer.ready_files():
            name = os.path.basename(path)
            next_at, attempts = self._backoff.get(name, (0.0, 0))
            if now < next_at:
                continue
            age = now - (Buffer.file_started_ms(path) / 1000.0)
            if age > MAX_BUFFER_AGE_S:
                self._drop_file(path)
                continue
            if self._send_file(path):
                self._backoff.pop(name, None)
            else:
                delay = min(BACKOFF_BASE_S * (2**attempts), BACKOFF_MAX_S)
                self._backoff[name] = (time.time() + delay, attempts + 1)

    def _send_file(self, path: str) -> bool:
        events = Buffer.read_events(path)
        if not events:
            try:
                os.unlink(path)
            except OSError:
                pass
            return True
        sender = self.sender or post_events
        result = sender(self.config.url, self.config.token, events)
        if not result.ok:
            return False
        try:
            os.unlink(path)
        except OSError:
            pass
        self._emit_drop_report()
        return True

    def _drop_file(self, path: str) -> None:
        """Past 72 h a batch is evidence of an outage, not evidence of a session."""
        events = Buffer.read_events(path)
        stamps = sorted(str(e.get("emitted_at")) for e in events if e.get("emitted_at"))
        try:
            os.unlink(path)
        except OSError:
            return
        self._backoff.pop(os.path.basename(path), None)
        record = self._dropped
        record["count"] = int(record.get("count", 0)) + len(events)
        record["files"] = int(record.get("files", 0)) + 1
        if stamps:
            oldest = record.get("oldest_event_at")
            newest = record.get("newest_event_at")
            record["oldest_event_at"] = min(oldest, stamps[0]) if oldest else stamps[0]
            record["newest_event_at"] = max(newest, stamps[-1]) if newest else stamps[-1]

    def _emit_drop_report(self) -> None:
        """One `plugin.buffer_dropped` on the first flush that succeeds after a drop."""
        if not self._dropped:
            return
        payload = dict(self._dropped)
        payload.setdefault("oldest_event_at", None)
        payload.setdefault("newest_event_at", None)
        payload["hook"] = "buffer"
        payload["hermes_version"] = hermes_version()
        self._dropped = {}
        self.emit("plugin.buffer_dropped", payload)


# --------------------------------------------------------------------------
# Fail-open decorator
# --------------------------------------------------------------------------


def guarded(hook: str, collector_ref: Callable[[], Optional[Collector]]) -> Callable:
    """Wrap a hook body so nothing it does can reach Hermes.

    Catches `BaseException` deliberately: a `MemoryError` raised inside our hook
    must not take the turn loop with it either. `SystemExit` is re-raised,
    because swallowing a shutdown would be worse than losing an event.

    The wrapped function is called as `fn(collector, *args, **kwargs)`.
    """

    def decorate(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> None:
            collector = collector_ref()
            if collector is None:
                return None
            try:
                collector.begin(kwargs.get("session_id") or kwargs.get("parent_session_id"))
            except Exception:  # noqa: BLE001 - config reload must not break a hook
                pass
            if not collector.hook_allowed(hook):
                return None
            start = time.perf_counter()
            try:
                fn(collector, *args, **kwargs)
            except SystemExit:
                raise
            except BaseException as exc:  # noqa: BLE001 - the whole point
                collector.record_failure(hook, exc)
            finally:
                elapsed_ms = (time.perf_counter() - start) * 1000.0
                if elapsed_ms > HOOK_BUDGET_MS:
                    collector.record_overrun(hook, elapsed_ms)
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
