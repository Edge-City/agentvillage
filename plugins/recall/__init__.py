"""recall — tenant-local memory recall for Agent Village Hermes agents (DATA-83).

Registers one Hermes tool, ``recall(query, since?)``, that searches the agent's
own memory — daily notes, ``MEMORY.md`` and the owner's private conversations —
through a SQLite FTS5 index kept at ``$HERMES_HOME/.recall/index.sqlite``.

The index and the search live in ``skills/recall/scripts/recall.ts`` (Bun,
``bun:sqlite``). This module is the Hermes-aware shell around it:

- the **group-session guard**, which needs the gateway's per-task session
  context and so can only be decided in-process;
- the **tool registration** (``ctx.register_tool``) and the schema the model
  sees;
- the **session-end rebuild** (``on_session_finalize``), run off-thread;
- the **``memory.recalled`` event**, published on the Hermes plugin event bus
  as ``recall:memory.recalled`` for the ``av-events`` plugin to pick up. The
  payload is a keyed hash of the query, the hit count, the top score and the
  surface — never the query text or any snippet.

No LLM, no embeddings, no network. Nothing is ever written under ``memory/``.
Python 3.11, standard library only. See ``skills/recall/README.md``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

__version__ = "0.1.0"

TOOL_NAME = "recall"
TOOLSET = "recall"
#: Published as ``recall:memory.recalled`` — Hermes forces the plugin's own
#: namespace onto every ``ctx.emit`` (``hermes_cli/plugins.py`` ``emit``).
EVENT_NAME = "memory.recalled"

REFUSAL_REASON = "unavailable in group sessions"
#: Chat types that are the owner's private surface. Anything else is refused;
#: an unrecognised chat type is treated as shared (default-deny). Mirrors
#: ``PRIVATE_CHAT_TYPES`` in ``recall.ts``, which enforces the same rule for a
#: terminal invocation of the CLI.
PRIVATE_CHAT_TYPES = frozenset({"", "dm", "private", "direct", "c2c"})

#: Bounded vocabulary for the event's ``surface``: arbitrary platform strings
#: never leave the sandbox.
SURFACE_BY_PLATFORM = {
    "telegram": "telegram",
    "cli": "desktop",
    "tui": "desktop",
    "desktop": "desktop",
    "acp": "desktop",
    "cron": "cron",
}
SURFACES = frozenset({"telegram", "desktop", "cron", "other", "unknown"})

MAX_QUERY_CHARS = 500
QUERY_TIMEOUT_S = 15.0
REBUILD_TIMEOUT_S = 120.0
REBUILD_MIN_INTERVAL_S = 30.0
#: Only these variables reach the Bun child: it needs no credentials, so it
#: gets none of the gateway's API keys or tokens.
CHILD_ENV_PASSTHROUGH = ("PATH", "HOME", "TZ", "LANG", "LC_ALL", "AV_RECALL_INDEX", "AV_RECALL_STATE_DB")
FALSEY = frozenset({"0", "false", "no", "off"})

TOOL_SCHEMA: dict[str, Any] = {
    "name": TOOL_NAME,
    "description": (
        "Search your own memory: dated daily notes (memory/YYYY-MM-DD.md), long-term memory "
        "(MEMORY.md) and past private conversations with your human. Local full-text search, no "
        "LLM. Returns dated snippets, each with a `ref` (`memory/2026-09-20.md:3-4`, "
        "`MEMORY.md:7-8`, or `session:<id>#<message>:<lines>`). Use it before you characterise "
        "the user, when they refer to something from earlier, or when a note from weeks ago "
        "might matter; a term you use about them must appear verbatim in a result. Read the "
        "referenced lines for more context. Never copy results into memory/ or any other "
        "file. Unavailable in group chats: it returns status `unavailable` there, with no data."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Keywords to look for, e.g. a person's name, project, or topic. Plain words; "
                    "all words are tried first, then any word."
                ),
            },
            "since": {
                "type": "string",
                "description": "Optional. Only return entries dated on or after this day (YYYY-MM-DD).",
            },
        },
        "required": ["query"],
    },
}


# --------------------------------------------------------------------------
# Environment and paths
# --------------------------------------------------------------------------


def hermes_home() -> Path:
    value = (os.environ.get("HERMES_HOME") or "").strip()
    if value:
        return Path(value)
    try:
        from hermes_constants import get_hermes_home  # noqa: PLC0415 - optional at test time

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001
        return Path.home() / ".hermes"


def enabled() -> bool:
    """Kill switch. Re-read on every call so a `.env` flip needs no restart."""
    return (os.environ.get("AV_RECALL_ENABLED") or "1").strip().lower() not in FALSEY


def script_path(home: Path) -> Path:
    override = (os.environ.get("AV_RECALL_SCRIPT") or "").strip()
    return Path(override) if override else home / "skills" / "recall" / "scripts" / "recall.ts"


def bun_path() -> Optional[str]:
    override = (os.environ.get("AV_RECALL_BUN") or "").strip()
    if override:
        return override if os.path.exists(override) else None
    found = shutil.which("bun")
    if found:
        return found
    for candidate in (Path.home() / ".bun" / "bin" / "bun", Path("/usr/local/bin/bun"), Path("/usr/bin/bun")):
        if candidate.exists():
            return str(candidate)
    return None


def child_env(home: Path, chat_type: str) -> dict[str, str]:
    env = {name: os.environ[name] for name in CHILD_ENV_PASSTHROUGH if name in os.environ}
    env["HERMES_HOME"] = str(home)
    # The CLI enforces the same guard; hand it the verdict we resolved here so a
    # stale process-wide mirror cannot disagree with the task-local context.
    env["HERMES_SESSION_CHAT_TYPE"] = chat_type
    return env


# --------------------------------------------------------------------------
# Session context
# --------------------------------------------------------------------------


def _session_value(name: str) -> Optional[str]:
    """Read a gateway session variable the way Hermes's own tools do.

    Returns the task-local ContextVar value when bound (even ""), else the
    ``os.environ`` mirror for a process that never bound a session (CLI).
    Returns None when the process *has* bound sessions but this task has none:
    the environment mirror is last-writer-wins across concurrent sessions and
    may belong to someone else's turn, so the value is unknowable.
    """
    try:
        from gateway import session_context as sc  # noqa: PLC0415 - absent outside Hermes
    except Exception:  # noqa: BLE001
        return os.environ.get(name, "")
    try:
        var = sc._VAR_MAP.get(name)  # noqa: SLF001 - same bridge tools/environments/local.py uses
        if var is not None:
            value = var.get()
            if value is not sc._UNSET:  # noqa: SLF001
                return "" if value is None else str(value)
            if sc.session_context_engaged():
                return None
        return os.environ.get(name, "")
    except Exception:  # noqa: BLE001 - private API drifted; use the public reader
        try:
            return sc.get_session_env(name, "")
        except Exception:  # noqa: BLE001
            return None


def chat_type() -> Optional[str]:
    value = _session_value("HERMES_SESSION_CHAT_TYPE")
    return None if value is None else value.strip().lower()


def is_private_session() -> bool:
    value = chat_type()
    return value is not None and value in PRIVATE_CHAT_TYPES


def surface() -> str:
    if (_session_value("HERMES_CRON_SESSION") or "").strip() == "1":
        return "cron"
    platform = (
        _session_value("HERMES_SESSION_PLATFORM") or _session_value("HERMES_SESSION_SOURCE") or ""
    ).strip().lower()
    if not platform:
        return "unknown"
    return SURFACE_BY_PLATFORM.get(platform, "other")


# --------------------------------------------------------------------------
# Query hash
# --------------------------------------------------------------------------


def _normalise_query(text: str) -> str:
    return " ".join(text.lower().split())


def _hash_key(home: Path) -> bytes:
    """Per-tenant random key, created on first use, mode 0600, outside memory/.

    A plain SHA-256 of a short query is reversible by dictionary ("maya",
    "cofounder"). Keying it keeps repeat-query counting within a tenant while
    making the hash useless to anyone without the sandbox.
    """
    directory = home / ".recall"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / "query-hash.key"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        key = path.read_text(encoding="ascii").strip()
        return bytes.fromhex(key)
    key = secrets.token_hex(32)
    with os.fdopen(fd, "w", encoding="ascii") as handle:
        handle.write(key)
    return bytes.fromhex(key)


def query_hash(home: Path, text: str) -> str:
    return hmac.new(_hash_key(home), _normalise_query(text).encode("utf-8"), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------
# Running the CLI
# --------------------------------------------------------------------------

Runner = Callable[[list, dict, Optional[str], float, str], subprocess.CompletedProcess]


def _run(argv: list, env: dict, stdin: Optional[str], timeout: float, cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603 - fixed argv, no shell
        argv,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        cwd=cwd,
        check=False,
    )


#: Test seam.
RUNNER: Runner = _run


def _result(status: str, reason: str, **extra: Any) -> dict:
    return {"status": status, "reason": reason, "hit_count": 0, "hits": [], **extra}


def _compact(raw: dict) -> dict:
    """What the model sees: the hits and just enough framing to use them."""
    hits = []
    for hit in raw.get("hits") or []:
        if not isinstance(hit, dict):
            continue
        hits.append(
            {
                "date": hit.get("date"),
                # `mtime` marks a MEMORY.md chunk dated by the file, not by its text.
                "date_source": hit.get("date_source"),
                "kind": hit.get("kind"),
                "ref": hit.get("ref"),
                "snippet": hit.get("snippet"),
                "score": hit.get("score"),
            }
        )
    return {
        "status": "ok",
        "match": raw.get("match"),
        "since": raw.get("since"),
        "hit_count": raw.get("hit_count", len(hits)),
        "top_score": raw.get("top_score"),
        "hits": hits,
    }


class Recall:
    """The tool handler, the rebuild trigger and the event publisher."""

    def __init__(self, ctx: Any = None, runner: Optional[Runner] = None) -> None:
        self.ctx = ctx
        self.runner = runner
        self._rebuild_lock = threading.Lock()
        self._rebuild_running = False
        self._rebuild_last = 0.0

    def _runner(self) -> Runner:
        return self.runner or RUNNER

    # -- tool -------------------------------------------------------------

    def handle(self, args: Any, **kwargs: Any) -> str:
        """Hermes tool handler: ``handler(args, task_id=..., session_id=..., ...)``.

        Always returns a JSON string. Any failure is a whole-result status with
        no hits — never partial data.
        """
        try:
            return json.dumps(self._handle(args, kwargs), ensure_ascii=False)
        except Exception:  # noqa: BLE001 - a tool must answer, not raise
            return json.dumps(_result("error", "internal_error"))

    def _handle(self, args: Any, kwargs: dict) -> dict:
        if not enabled():
            return _result("unavailable", "recall is disabled on this agent")
        chat = chat_type()
        if chat is None or chat not in PRIVATE_CHAT_TYPES:
            return _result("unavailable", REFUSAL_REASON)

        args = args if isinstance(args, dict) else {}
        text = args.get("query")
        if not isinstance(text, str) or not text.strip():
            return _result("error", "empty_query")
        if len(text) > MAX_QUERY_CHARS:
            return _result("error", "query_too_long")
        since = args.get("since")
        if since is not None and not isinstance(since, str):
            return _result("error", "invalid_since")

        home = hermes_home()
        script = script_path(home)
        if not script.is_file():
            return _result("unavailable", "recall skill is not installed")
        bun = bun_path()
        if bun is None:
            return _result("unavailable", "bun runtime not found")

        argv = [bun, str(script), "query", "--query-stdin"]
        if since and since.strip():
            argv += ["--since", since.strip()]
        try:
            proc = self._runner()(argv, child_env(home, chat), text, QUERY_TIMEOUT_S, str(home))
        except subprocess.TimeoutExpired:
            return _result("error", "timeout")
        except OSError:
            return _result("unavailable", "bun runtime could not start")

        try:
            raw = json.loads((proc.stdout or "").strip().splitlines()[-1])
        except (ValueError, IndexError):
            return _result("error", "bad_output")
        if not isinstance(raw, dict):
            return _result("error", "bad_output")
        status = raw.get("status")
        if status != "ok":
            reason = raw.get("reason") if isinstance(raw.get("reason"), str) else "error"
            return _result("unavailable" if status == "unavailable" else "error", reason)

        result = _compact(raw)
        self._publish(home, text, result, kwargs.get("session_id"))
        return result

    # -- event ------------------------------------------------------------

    def _publish(self, home: Path, text: str, result: dict, session_id: Any) -> None:
        """Publish ``memory.recalled`` on the plugin bus. Never raises.

        The payload is built from an explicit field list: nothing from the
        query or the hits except counts and a keyed hash can reach it.
        """
        emit = getattr(self.ctx, "emit", None)
        if not callable(emit):
            return
        try:
            top = result.get("top_score")
            payload = {
                "query_hash": query_hash(home, text),
                "hit_count": int(result.get("hit_count") or 0),
                "top_score": round(float(top), 4) if isinstance(top, (int, float)) and not isinstance(top, bool) else None,
                "surface": surface(),
                # Envelope ref only; av-events moves it out of the payload.
                "session_id": str(session_id) if session_id else None,
            }
            emit(EVENT_NAME, payload)
        except Exception:  # noqa: BLE001 - telemetry must not break recall
            pass

    # -- rebuild ----------------------------------------------------------

    def request_rebuild(self) -> bool:
        """Start an incremental rebuild off-thread. Single-flight, debounced.

        A skipped request costs nothing: every query rebuilds incrementally
        before it searches, so the index is never stale when read.
        """
        if not enabled():
            return False
        with self._rebuild_lock:
            now = time.monotonic()
            if self._rebuild_running or (self._rebuild_last and now - self._rebuild_last < REBUILD_MIN_INTERVAL_S):
                return False
            self._rebuild_running = True
        thread = threading.Thread(target=self._rebuild, name="recall-rebuild", daemon=True)
        thread.start()
        return True

    def _rebuild(self) -> None:
        try:
            home = hermes_home()
            script = script_path(home)
            bun = bun_path()
            if bun is None or not script.is_file():
                return
            # `rebuild` returns counts only, so it may run whatever session
            # just ended; the chat type handed down is the empty, private one.
            self._runner()([bun, str(script), "rebuild"], child_env(home, ""), None, REBUILD_TIMEOUT_S, str(home))
        except Exception:  # noqa: BLE001 - off-thread, fail open
            pass
        finally:
            with self._rebuild_lock:
                self._rebuild_running = False
                self._rebuild_last = time.monotonic()

    def on_session_finalize(self, **kwargs: Any) -> None:
        """Hook body. Returns None always; never raises into Hermes."""
        try:
            self.request_rebuild()
        except BaseException as exc:  # noqa: BLE001
            if isinstance(exc, SystemExit):
                raise
        return None


_RECALL: Optional[Recall] = None
_REGISTERED = False


def register(ctx) -> None:
    """Hermes plugin entrypoint. Synchronous and idempotent."""
    global _RECALL, _REGISTERED
    if _REGISTERED:
        return
    _RECALL = Recall(ctx)
    ctx.register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET,
        schema=TOOL_SCHEMA,
        handler=_RECALL.handle,
        description=TOOL_SCHEMA["description"],
    )
    try:
        ctx.register_hook("on_session_finalize", _RECALL.on_session_finalize)
    except Exception:  # noqa: BLE001 - the tool still works without the warm-up
        pass
    _REGISTERED = True


__all__ = [
    "register",
    "Recall",
    "TOOL_NAME",
    "TOOL_SCHEMA",
    "EVENT_NAME",
    "PRIVATE_CHAT_TYPES",
    "SURFACES",
    "query_hash",
    "is_private_session",
    "surface",
    "__version__",
]
