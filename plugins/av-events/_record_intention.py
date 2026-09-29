"""`record_intention`: the one front door for intentions (DATA-212).

The agent records every intention through this tool, never through Index's
`create_intent` directly. For an explicit intention (`source` = `message`,
`onboarding` or `note`) the tool creates the intent on Index in the same call
and returns Index's id; for an ambient one (the agent inferred it, or a cron
run found it) it never touches Index and holds the intention locally until the
resident confirms it. Ambient-intents spec §4, §5, §6 Option 2.

**One event per call, from the observer.** This module emits nothing. The
plugin's `post_tool_call` observer (`_intentions.plan_record`) reads the JSON
this tool returns and emits one `intention.*` with `capture_path =
record_intention`. The Index call is made here over plain HTTP, not through a
Hermes MCP tool call, so the `index_tool` observer never sees it. Result keys
the observer reads (only for this unprefixed tool, never an MCP server's
`record_intention`): `action`, `intention_id`, `index_intent_id`, `source`,
`publish_refused` (a code) and `local_reason` (`participant_asked` | `personal`).

**Ids.** A published capture's `intention_id` is Index's intent id, as an
observed Index `create_intent` would be, so the poller corroborates it by id.
Only an intention that stays local gets a uuid v7 minted here.

**The wire.** The poller's MCP streamable-HTTP sequence (`agentvillage-data`
`src/jobs/index-poller.ts` `indexMcpClient`): POST `initialize`, keep the
`mcp-session-id` response header, POST `notifications/initialized`, POST
`tools/call`, each with `x-api-key`, `content-type: application/json` and
`accept: application/json, text/event-stream`, and no other header (the
poller sends none; Hermes's own Index connection also sends `x-index-surface`
and `x-index-telegram-username`, whether a create needs them is a dogfood
check). JSON or SSE responses. Redirects refused, proxies ignored
(`_core.NO_REDIRECT_OPENER`), https only.

**Deadline and the ambiguous timeout.** Each socket operation is bounded by
`INDEX_TIMEOUT_S` and the whole sequence by `INDEX_DEADLINE_S` (30 s: Index's
`create_intent` runs a multi-stage verification graph that can take tens of
seconds). Past the deadline the capture is recorded locally with
`publish_refused: timeout`, and Index may still finish the write, so one
intention can then have two rows: this local one and the Index one the poller
sees. The data side reconciles them by (tenant, `text_hash`): the poller
hashes the same `description` text. Dogfood latency is measured before the
switch goes on anywhere else.

**Switch.** Registered only when `AV_RECORD_INTENTION` is `1|true|yes|on`
(default off). Hermes loads `$HERMES_HOME/.env` into the process environment
at startup, so a change there takes effect after a gateway restart, in both
directions. The handler re-reads the switch from the process environment at
every call, which honours only a change made to `os.environ` itself.

**Who is speaking: the tool's own session lineage (refutation F3).** Whether a
call may publish is decided from lineage this module records in its own hook
listeners (`on_session_start` and `pre_api_request` give the platform,
`subagent_start` the parent). They are registered with the tool and do not go
through the collector's `hook_allowed`, `AV_EVENTS_ENABLED`, the breaker or a
degraded session, so turning telemetry off, disabling a telemetry hook or an
unload never loosens the gate. It fails closed: a session whose platform was
never seen, a `cron_` id, `platform=cron`, or a subagent whose ancestry is
unknown or reaches a cron run, is held as ambient and never publishes.
[Reversal: gate on `_is_cron_session` over the collector again.]

**Cron updates (F4).** In a held session `action=update` never mirrors to
Index; the local event carries `publish_refused="cron_held"` and `source`
ambient. A withdrawal may still mirror (it removes, never asserts).
[Reversal: mirror updates from any session.]

**Rate cap.** At most `AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR` (default 20)
Index `create_intent` attempts per rolling hour per tenant, counted across
processes in the local map (timestamps only, under its lock). Over the cap the
capture is local with `publish_refused="rate_capped"`; a count that cannot be
read or written refuses too, as `rate_unavailable`. An attempt counts whether
or not Index accepts it. [Reversal: set the cap very large.]

**Fail open.** The handler never raises into Hermes. Logs carry codes, ids and
counts; never the intention's text, never the key.

**Local map (F5, R9).** `$HERMES_HOME/av-events/intentions.json` (0600), guarded
by `fcntl.flock` on the sibling `intentions.json.lock` around every
read-modify-write: id -> `{published, source}`, plus `text_hash` (the same
sha256 the event carries) for a held ambient entry only, so the held text
cannot be re-captured as `message`/`onboarding`/`note` and published around
the confirmation (`held_ambient_exists`). [Reversal R9: drop the hash and rely
on the prompt.] A corrupt file is renamed aside to
`intentions.json.corrupt-<n>`, logged `map_corrupt`, and the map starts empty.
An update or withdrawal of an id not in the map mirrors nothing: its event is
ambient with `publish_refused="unknown_id"`.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from typing import Any, Callable, Optional

try:  # POSIX; without it the map is guarded by the in-process lock only.
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

from ._core import (
    DIR_MODE,
    FILE_MODE,
    NO_REDIRECT_OPENER,
    env,
    hash_text,
    hermes_home,
    is_redirect,
    register_literal_secret,
    uuid7,
)
from ._intentions import (
    LOCAL_REASONS,
    RECORD_INTENTION_TOOL,
    RESTRICTIVE_SOURCE,
    _first_id,
    _first_json,
    result_intent,
    valid_id,
)

logger = logging.getLogger("av-events")

TOOL_NAME = RECORD_INTENTION_TOOL
TOOLSET = "av-events"
SWITCH = "AV_RECORD_INTENTION"
TRUTHY = frozenset({"1", "true", "yes", "on"})
DEFAULT_MCP_URL = "https://protocol.index.network/mcp"
#: Per socket operation, and for the whole MCP sequence (see the header).
INDEX_TIMEOUT_S = 30.0
INDEX_DEADLINE_S = 30.0
MAX_BODY_BYTES = 256 * 1024
MAX_MAP_ENTRIES = 10_000
MAP_FILE = "intentions.json"

RATE_CAP_ENV = "AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR"
DEFAULT_RATE_CAP = 20
RATE_WINDOW_S = 3600.0

ACTIONS = ("capture", "update", "withdraw", "confirm")
SOURCES = ("message", "onboarding", "note", "ambient")
EXPLICIT_SOURCES = frozenset({"message", "onboarding", "note"})

#: Spec §4. The second sentence is verbatim from the spec.
PUBLISH_RULE = (
    "Explicit intents (source message, onboarding or note) are published to Index by default. "
    "The two legitimate reasons an explicit intent stays local: the resident asked, or the "
    "content is personal."
)

TOOL_DESCRIPTION = (
    "Record an intention: something the person you work for wants, is looking for, or is open "
    "to, that meeting people they do not already know could serve. This is the one front door "
    "for intentions: use it instead of calling Index create_intent yourself; it publishes to "
    "Index in the same call and returns the intention_id to keep for later update or withdraw "
    "calls. "
    + PUBLISH_RULE
    + " Only then pass publish=false, with reason participant_asked or personal. source: message "
    "(they told you), onboarding (answered during setup), note (their own words in their "
    "notes), ambient (you inferred it, or a background or cron run found it). Ambient "
    "intentions are never published by this tool: they are held until the resident confirms, "
    "and action=confirm is not available yet. action=update (intention_id, text) changes an "
    "intention you recorded; action=withdraw (intention_id) retires it."
)

TOOL_SCHEMA: dict = {
    "name": TOOL_NAME,
    "description": TOOL_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS),
                       "description": "capture (default), update, withdraw, or confirm a held ambient one."},
            "text": {"type": "string", "description": "The intention in the resident's words. Required for capture and update."},
            "summary": {"type": "string", "description": "Optional one-line summary."},
            "source": {"type": "string", "enum": list(SOURCES), "description": "Where it came from. Required for capture."},
            "publish": {"type": "boolean",
                        "description": "Default true. false only when the resident asked or the content is personal; then reason is required. Ignored for ambient."},
            "reason": {"type": "string", "enum": sorted(LOCAL_REASONS),
                       "description": "Why an explicit intention stays local. Required when publish is false."},
            "intention_id": {"type": "string", "description": "The id a capture returned. Required for update, withdraw and confirm."},
        },
        "additionalProperties": False,
    },
}

REFUSALS: dict[str, str] = {
    "disabled": "record_intention is switched off for this agent; nothing was recorded.",
    "action_invalid": "Unknown action; use capture, update, withdraw or confirm. Nothing was recorded.",
    "text_required": "Nothing was recorded: text is required, in the resident's own words.",
    "source_required": "Nothing was recorded: source is required (message, onboarding, note or ambient).",
    "source_invalid": "Nothing was recorded: source must be message, onboarding, note or ambient.",
    "publish_invalid": "Nothing was recorded: publish must be true or false.",
    "reason_required": (
        "Nothing was recorded: an explicit intention stays off Index only when the resident asked "
        "or the content is personal, so publish=false needs reason participant_asked or personal."
    ),
    "reason_invalid": "Nothing was recorded: reason must be participant_asked or personal.",
    "intention_id_unexpected": "Nothing was recorded: a capture takes no intention_id; use action=update.",
    "intention_id_required": "Nothing was recorded: this action needs the intention_id a capture returned.",
    "intention_id_invalid": "Nothing was recorded: that intention_id is not one this tool returns.",
    "held_ambient_exists": (
        "Nothing was recorded: this is already held as an ambient intention. A held intention is "
        "published only through the resident's confirmation, never by capturing it again."
    ),
    "no_confirmation_channel": (
        "Cannot confirm yet: confirmation must come from the resident through approval.md, which "
        "this village does not have yet, and a reply you read in chat does not count. The "
        "intention stays held and unpublished; do not publish it another way."
    ),
    "confirmation_not_wired": (
        "Cannot confirm yet: the approval.md confirmation path is not wired into this tool. The "
        "intention stays held and unpublished; do not publish it another way."
    ),
    "internal": "record_intention could not run just now; nothing was recorded. Do not publish it another way.",
}


def switch_on() -> bool:
    return env(SWITCH).strip().lower() in TRUTHY


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() else None


def _bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        folded = value.strip().lower()
        if folded in ("true", "yes"):
            return True
        if folded in ("false", "no"):
            return False
    return None


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _refuse(code: str) -> dict:
    return {"success": False, "error": code, "message": REFUSALS[code]}


def url_allowed(url: str) -> bool:
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return parts.scheme == "https" and bool(parts.hostname)


#: Tests replace this: seconds since the epoch, for the rate cap.
_clock: Callable[[], float] = time.time


# ---- Index over MCP streamable HTTP ---------------------------------------

#: Tests replace this. Anything with `.open(request, timeout=...)`.
_OPENER: Any = NO_REDIRECT_OPENER


class IndexFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _read_rpc(content_type: str, raw: bytes) -> dict:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise IndexFailure("malformed") from None
    if "text/event-stream" in content_type:
        found: Optional[dict] = None
        for line in text.split("\n"):
            if not line.startswith("data:"):
                continue
            try:
                message = json.loads(line[5:].lstrip())
            except ValueError:
                continue
            if isinstance(message, dict) and ("result" in message or "error" in message):
                found = message
        if found is None:
            raise IndexFailure("malformed")
        return found
    try:
        message = json.loads(text)
    except ValueError:
        raise IndexFailure("malformed") from None
    if not isinstance(message, dict):
        raise IndexFailure("malformed")
    return message


class _Session:
    def __init__(self, url: str, key: str, timeout: float) -> None:
        self.url, self.key, self.timeout = url, key, timeout
        self.session_id: Optional[str] = None
        self.rpc_id = 0

    def post(self, body: dict) -> tuple[str, bytes, Optional[str]]:
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "x-api-key": self.key,
        }
        if self.session_id is not None:
            headers["mcp-session-id"] = self.session_id
        request = urllib.request.Request(
            self.url, data=json.dumps({"jsonrpc": "2.0", **body}).encode("utf-8"), headers=headers, method="POST"
        )
        try:
            with _OPENER.open(request, timeout=self.timeout) as response:
                status = int(getattr(response, "status", 0) or 0)
                content_type = str(response.headers.get("content-type") or "")
                session = response.headers.get("mcp-session-id")
                raw = response.read(MAX_BODY_BYTES + 1)
        except urllib.error.HTTPError as exc:
            try:
                exc.read()
            except Exception:  # noqa: BLE001
                pass
            code = int(getattr(exc, "code", 0) or 0)
            raise IndexFailure("redirect" if is_redirect(code) else f"http_{code}") from None
        except TimeoutError:
            raise IndexFailure("timeout") from None
        except urllib.error.URLError as exc:
            if isinstance(getattr(exc, "reason", None), TimeoutError):
                raise IndexFailure("timeout") from None
            raise IndexFailure("transport") from None
        except IndexFailure:
            raise
        except Exception:  # noqa: BLE001 - sockets, TLS, DNS
            raise IndexFailure("transport") from None
        if is_redirect(status):
            raise IndexFailure("redirect")
        if not 200 <= status < 300:
            raise IndexFailure(f"http_{status}")
        if len(raw) > MAX_BODY_BYTES:
            raise IndexFailure("too_large")
        return content_type, raw, session

    def call(self, method: str, params: dict) -> Any:
        self.rpc_id += 1
        content_type, raw, session = self.post({"id": self.rpc_id, "method": method, "params": params})
        if method == "initialize":
            self.session_id = session if isinstance(session, str) and session else None
        message = _read_rpc(content_type, raw)
        if message.get("error") is not None:
            raise IndexFailure("rpc_error")
        return message.get("result")

    def notify(self, method: str) -> None:
        self.post({"method": method})


def _tool_payload(result: Any) -> Any:
    if not isinstance(result, dict):
        raise IndexFailure("malformed")
    if result.get("isError") is True:
        raise IndexFailure("rejected")
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        payload: Any = structured
    else:
        text = None
        content = result.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                    text = block["text"]
                    break
        if text is None or not text.strip():
            raise IndexFailure("malformed")
        payload = _first_json(text)
    if isinstance(payload, dict) and "success" in payload and payload["success"] is not True:
        raise IndexFailure("rejected")  # "too vague"
    return payload


def _mcp_tool(url: str, key: str, tool: str, arguments: dict, timeout: float) -> Any:
    session = _Session(url, key, timeout)
    session.call("initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "agentvillage-av-events-record-intention", "version": "1"},
    })
    session.notify("notifications/initialized")
    return _tool_payload(session.call("tools/call", {"name": tool, "arguments": arguments}))


def _join(worker: threading.Thread, deadline: float) -> None:
    """How long the caller waits on the worker. Tests replace it: no wall clock."""
    worker.join(deadline)


def index_tool_call(tool: str, arguments: dict, *, timeout: Optional[float] = None,
                    deadline: Optional[float] = None) -> tuple[Any, Optional[str]]:
    """`(payload, None)` or `(None, code)`. Never raises. A `timeout` is ambiguous:
    Index may still finish the write after the thread is abandoned."""
    timeout = INDEX_TIMEOUT_S if timeout is None else timeout
    deadline = INDEX_DEADLINE_S if deadline is None else deadline
    key = env("INDEX_API_KEY")
    if not key:
        return None, "no_key"
    register_literal_secret(key)
    url = env("INDEX_MCP_URL") or DEFAULT_MCP_URL
    if not url_allowed(url):
        return None, "url_refused"
    box: list = []

    def run() -> None:
        try:
            box.append((_mcp_tool(url, key, tool, arguments, timeout), None))
        except IndexFailure as exc:
            box.append((None, exc.code))
        except BaseException:  # noqa: BLE001
            box.append((None, "transport"))

    worker = threading.Thread(target=run, name="av-events-record-intention", daemon=True)
    worker.start()
    _join(worker, deadline)
    if worker.is_alive() or not box:
        return None, "timeout"
    return box[0]


def publish_intent(text: str) -> tuple[Optional[str], Optional[str]]:
    payload, code = index_tool_call("create_intent", {"description": text})
    if code is not None:
        return None, code
    intent_id = _first_id(result_intent(payload))
    if intent_id is None or not valid_id(intent_id):
        return None, "malformed"
    return intent_id, None


def mirror_update(intent_id: str, *, description: Optional[str] = None, archive: bool = False) -> Optional[str]:
    # `id` as the Index skill's heartbeat names it (`update_intent(id, status=...)`);
    # unconfirmed against Index's tool schema, a dogfood check.
    arguments: dict[str, Any] = {"id": intent_id}
    if archive:
        arguments["status"] = "archived"
    if description is not None:
        arguments["description"] = description
    _, code = index_tool_call("update_intent", arguments)
    return code




# ---- Session lineage (F3) --------------------------------------------------

#: Sessions and parents remembered; the oldest fall off first.
MAX_LINEAGE = 4096
#: How far up a chain of delegated subagents to look.
MAX_LINEAGE_DEPTH = 8
#: Hermes names a delegated child's platform `subagent` (`tools/delegate_tool.py`).
SUBAGENT_PLATFORM = "subagent"
CRON_PLATFORM = "cron"

_LINEAGE_LOCK = threading.Lock()
_PLATFORMS: "OrderedDict[str, str]" = OrderedDict()
_PARENTS: "OrderedDict[str, str]" = OrderedDict()


def _bounded_set(store: "OrderedDict[str, str]", key: str, value: str) -> None:
    store.pop(key, None)
    store[key] = value
    while len(store) > MAX_LINEAGE:
        store.popitem(last=False)


def note_platform(session_id: Any, platform: Any) -> None:
    sid = str(session_id or "").strip()
    name = str(platform or "").strip().lower()
    if not sid or not name:
        return
    with _LINEAGE_LOCK:
        # Sticky on the restrictive side: once a session is seen as cron it stays cron.
        if _PLATFORMS.get(sid) == CRON_PLATFORM:
            return
        _bounded_set(_PLATFORMS, sid, name)


def note_parent(child_session_id: Any, parent_session_id: Any) -> None:
    child = str(child_session_id or "").strip()
    parent = str(parent_session_id or "").strip()
    if child and parent and child != parent:
        with _LINEAGE_LOCK:
            _bounded_set(_PARENTS, child, parent)


def _listener(fn: Callable[..., None]) -> Callable[..., None]:
    def listener(*_args: Any, **kwargs: Any) -> None:
        try:
            fn(**kwargs)
        except SystemExit:
            raise
        except BaseException:  # noqa: BLE001 - a listener never reaches Hermes
            pass

    listener.__name__ = f"record_intention_{fn.__name__}"
    return listener


def _on_platform(**kwargs: Any) -> None:
    note_platform(kwargs.get("session_id"), kwargs.get("platform"))


def _on_subagent_start(**kwargs: Any) -> None:
    note_parent(kwargs.get("child_session_id"), kwargs.get("parent_session_id"))


#: The tool's own listeners: never through the collector's guard.
LINEAGE_HOOKS: dict[str, Callable[..., None]] = {
    "on_session_start": _listener(_on_platform),
    "pre_api_request": _listener(_on_platform),
    "subagent_start": _listener(_on_subagent_start),
}


def held_reason(session_id: Optional[str]) -> Optional[str]:
    """None when the session may publish; `cron` or `unknown` when it may not.

    Fails closed: only a session (or the root of its delegation chain) whose
    platform was seen, and is neither `cron` nor `subagent`, may publish.
    """
    current = str(session_id or "").strip()
    with _LINEAGE_LOCK:
        for _ in range(MAX_LINEAGE_DEPTH):
            if not current:
                return "unknown"
            if current.startswith("cron_"):
                return "cron"
            platform = _PLATFORMS.get(current)
            if platform == CRON_PLATFORM:
                return "cron"
            parent = _PARENTS.get(current)
            if parent is not None:
                current = parent
                continue
            if platform is None or platform == SUBAGENT_PLATFORM:
                return "unknown"
            return None
    return "unknown"


# ---- Local map (F5) --------------------------------------------------------

_MAP_LOCK = threading.Lock()


class MapUnreadable(Exception):
    """The map exists but could not be read: never overwrite it."""


def map_path() -> str:
    return os.path.join(hermes_home(), "av-events", MAP_FILE)


class _Locked:
    """The in-process lock plus `flock` on `intentions.json.lock`, for one
    read-modify-write across every process of this tenant."""

    def __enter__(self) -> "_Locked":
        _MAP_LOCK.acquire()
        self._fd: Optional[int] = None
        try:
            directory = os.path.dirname(map_path())
            os.makedirs(directory, mode=DIR_MODE, exist_ok=True)
            self._fd = os.open(map_path() + ".lock", os.O_RDWR | os.O_CREAT, FILE_MODE)
            if fcntl is not None:
                fcntl.flock(self._fd, fcntl.LOCK_EX)
        except BaseException:
            self._release()
            raise
        return self

    def _release(self) -> None:
        try:
            if self._fd is not None:
                if fcntl is not None:
                    fcntl.flock(self._fd, fcntl.LOCK_UN)
                os.close(self._fd)
        finally:
            self._fd = None
            _MAP_LOCK.release()

    def __exit__(self, *exc: Any) -> None:
        self._release()


def _set_aside(path: str) -> None:
    n = 1
    while os.path.exists(f"{path}.corrupt-{n}"):
        n += 1
    os.replace(path, f"{path}.corrupt-{n}")
    logger.warning("av-events: record_intention map_corrupt=%d", n)


def _load_locked() -> tuple[dict[str, dict], list[float]]:
    """(entries, publish timestamps). Call under `_Locked`."""
    path = map_path()
    try:
        with open(path, encoding="utf-8") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return {}, []
    except OSError:
        raise MapUnreadable() from None
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    entries = data.get("intentions") if isinstance(data, dict) else None
    if not isinstance(entries, dict):
        _set_aside(path)
        return {}, []
    clean = {k: v for k, v in entries.items() if valid_id(k) and isinstance(v, dict)}
    stamps = data.get("publishes")
    publishes = [float(t) for t in stamps if isinstance(t, (int, float)) and not isinstance(t, bool)] if isinstance(stamps, list) else []
    return clean, publishes


def _save_locked(entries: dict[str, dict], publishes: list[float]) -> None:
    path = map_path()
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".intentions.", dir=directory)
    try:
        os.fchmod(fd, FILE_MODE)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"v": 1, "intentions": entries, "publishes": publishes}, handle, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load_map() -> dict[str, dict]:
    with _Locked():
        return _load_locked()[0]


def lookup(intention_id: str) -> Optional[dict]:
    """The entry, or None when the id is unknown or the map cannot be read."""
    try:
        return _load_map().get(intention_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: record_intention map_read_failed=%s", type(exc).__name__)
        return None


def held_hash_exists(text_hash: str) -> bool:
    try:
        entries = _load_map()
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: record_intention map_read_failed=%s", type(exc).__name__)
        return False
    return any(v.get("text_hash") == text_hash and v.get("published") is not True for v in entries.values())


def remember(intention_id: str, *, published: bool, source: str, text_hash: Optional[str] = None) -> None:
    """Best effort: a map that cannot be written costs a later Index mirror, not the capture."""
    try:
        with _Locked():
            entries, publishes = _load_locked()
            entries.pop(intention_id, None)
            entry: dict[str, Any] = {"published": published, "source": source}
            # R9: the hash only for a held ambient entry.
            if text_hash is not None and source == RESTRICTIVE_SOURCE and not published:
                entry["text_hash"] = text_hash
            entries[intention_id] = entry
            while len(entries) > MAX_MAP_ENTRIES:
                entries.pop(next(iter(entries)))
            _save_locked(entries, publishes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: record_intention map_write_failed=%s", type(exc).__name__)


def rate_cap() -> int:
    raw = env(RATE_CAP_ENV).strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_RATE_CAP
    return value if value >= 0 else DEFAULT_RATE_CAP


def reserve_publish() -> Optional[str]:
    """Count one `create_intent` attempt in the rolling hour. None when counted,
    `rate_capped` when the hour is full, `rate_unavailable` when the count
    cannot be read or written (fails closed, visibly)."""
    cap = rate_cap()
    now = float(_clock())
    try:
        with _Locked():
            entries, publishes = _load_locked()
            recent = [t for t in publishes if now - RATE_WINDOW_S < t <= now]
            if len(recent) >= cap:
                return "rate_capped"
            recent.append(now)
            _save_locked(entries, recent)
            return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: record_intention rate_count_failed=%s", type(exc).__name__)
        return "rate_unavailable"


# ---- Actions --------------------------------------------------------------


def _publish_precheck() -> Optional[str]:
    """`no_key` / `url_refused` before an attempt is counted against the cap."""
    if not env("INDEX_API_KEY"):
        return "no_key"
    if not url_allowed(env("INDEX_MCP_URL") or DEFAULT_MCP_URL):
        return "url_refused"
    return None


def _capture(args: dict, held: Optional[str]) -> dict:
    if args.get("intention_id") is not None:
        return _refuse("intention_id_unexpected")
    text = _text(args.get("text"))
    if text is None:
        return _refuse("text_required")
    if _blank(args.get("source")):
        return _refuse("source_required")
    source = str(args.get("source")).strip().lower()
    if source not in SOURCES:
        return _refuse("source_invalid")
    if held is not None:
        source = RESTRICTIVE_SOURCE  # no participant is known to be speaking
    publish = True
    if args.get("publish") is not None:
        parsed = _bool(args.get("publish"))
        if parsed is None:
            return _refuse("publish_invalid")
        publish = parsed
    digest = hash_text(text)
    if source in EXPLICIT_SOURCES and digest is not None and held_hash_exists(digest):
        return _refuse("held_ambient_exists")

    # `action` tells the observer what was done when the call left it to the default.
    result: dict[str, Any] = {"success": True, "action": "capture", "source": source}
    if source == RESTRICTIVE_SOURCE:
        intention_id = uuid7()
        result.update(intention_id=intention_id, index_intent_id=None, published=False, held=True)
        result["message"] = (
            f"Held as an ambient intention (intention_id {intention_id}). It stays off Index until the "
            "resident confirms it, and confirmation is not available yet: do not publish it another way."
        )
    elif not publish:
        if _blank(args.get("reason")):
            return _refuse("reason_required")
        reason = str(args.get("reason")).strip().lower()
        if reason not in LOCAL_REASONS:
            return _refuse("reason_invalid")
        intention_id = uuid7()
        result.update(intention_id=intention_id, index_intent_id=None, published=False, local_reason=reason)
        result["message"] = f"Recorded locally, not published to Index (intention_id {intention_id}, reason {reason})."
    else:
        code = _publish_precheck()
        index_id: Optional[str] = None
        if code is None:
            code = reserve_publish()
        if code is None:
            index_id, code = publish_intent(text)
        if index_id is not None:
            result.update(intention_id=index_id, index_intent_id=index_id, published=True)
            result["message"] = f"Recorded and published to Index (intention_id {index_id})."
        else:
            intention_id = uuid7()
            result.update(intention_id=intention_id, index_intent_id=None, published=False, publish_refused=code)
            if code == "rejected":
                tail = (
                    "Index did not accept it, most likely as too vague. Ask the resident one clarifying "
                    "question; if they clarify, capture the clarified version. Do not retry with a paraphrase."
                )
            elif code == "timeout":
                tail = "Index did not answer in time. Do not retry; it may still appear on Index."
            elif code == "rate_capped":
                tail = "This agent has reached its hourly limit for publishing to Index. It is recorded; do not retry it."
            else:
                tail = "Index could not take it just now. It is recorded; do not retry it with another tool."
            result["message"] = f"Recorded locally (intention_id {intention_id}, code {code}). {tail}"
    remember(
        result["intention_id"],
        published=bool(result["published"]),
        source=source,
        text_hash=digest if source == RESTRICTIVE_SOURCE else None,
    )
    return result


def _update_or_withdraw(action: str, args: dict, held: Optional[str]) -> dict:
    if _blank(args.get("intention_id")):
        return _refuse("intention_id_required")
    intention_id = str(args.get("intention_id")).strip()
    if not valid_id(intention_id):
        return _refuse("intention_id_invalid")
    text = _text(args.get("text"))
    if action == "update" and text is None:
        return _refuse("text_required")
    verb = "Updated" if action == "update" else "Withdrew"

    entry = lookup(intention_id)
    if entry is None:
        # F5/F7: not one this tool recorded here (or the map was lost). Mirror
        # nothing, claim nothing, and label it the restrictive way.
        return {
            "success": True,
            "action": action,
            "intention_id": intention_id,
            "index_intent_id": None,
            "published": False,
            "source": RESTRICTIVE_SOURCE,
            "publish_refused": "unknown_id",
            "message": (
                f"{verb} intention {intention_id} in the local record only. This agent has no record of "
                "publishing it, so nothing was changed on Index; if it was published some other way it "
                "may still be there."
            ),
        }

    published = entry.get("published") is True
    source = entry.get("source") if entry.get("source") in SOURCES else RESTRICTIVE_SOURCE
    if held is not None:
        source = RESTRICTIVE_SOURCE
    result: dict[str, Any] = {
        "success": True,
        "action": action,
        "intention_id": intention_id,
        "index_intent_id": intention_id if published else None,
        "published": published,
        "source": source,
    }
    code: Optional[str] = None
    if published:
        if action == "update" and held is not None:
            code = "cron_held"  # F4: inferred text never overwrites a live intent
        elif action == "update":
            code = mirror_update(intention_id, description=text)
        else:
            code = mirror_update(intention_id, archive=True)
        if code is not None:
            result["publish_refused"] = code
    if not published:
        result["message"] = f"{verb} intention {intention_id} (kept locally; it is not on Index)."
    elif code is None:
        result["message"] = f"{verb} intention {intention_id} here and on Index."
    elif code == "cron_held":
        result["message"] = f"{verb} intention {intention_id} locally; a background run does not change it on Index."
    else:
        result["message"] = f"{verb} intention {intention_id} here; Index was not updated (code {code})."
    return result


def record_intention_answer(args: Any, session_id: Optional[str]) -> dict:
    if not switch_on():
        return _refuse("disabled")
    safe = args if isinstance(args, dict) else {}
    raw_action = safe.get("action")
    action = raw_action.strip().lower() if isinstance(raw_action, str) and raw_action.strip() else "capture"
    if action not in ACTIONS:
        return _refuse("action_invalid")
    if action == "confirm":
        # Spec §5.3: a parsed reply is not a confirmation. DATA-213 wires approval.md.
        return _refuse("confirmation_not_wired" if env("AV_APPROVAL_URL") else "no_confirmation_channel")
    try:
        held = held_reason(session_id)
    except Exception:  # noqa: BLE001 - unsure is held
        held = "unknown"
    if action == "capture":
        return _capture(safe, held)
    return _update_or_withdraw(action, safe, held)


def make_handler() -> Callable[..., str]:
    def record_intention_tool(args: Any = None, **kwargs: Any) -> str:
        action = "capture"
        held = "-"
        try:
            if isinstance(args, dict) and isinstance(args.get("action"), str) and args["action"].strip():
                action = args["action"].strip().lower()
            session_id = kwargs.get("session_id")
            sid = str(session_id) if session_id else None
            try:
                held = held_reason(sid) or "-"
            except Exception:  # noqa: BLE001
                held = "unknown"
            result = record_intention_answer(args, sid)
        except SystemExit:
            raise
        except BaseException as exc:  # noqa: BLE001 - fail open
            try:
                logger.warning("av-events: record_intention failed=%s", type(exc).__name__)
            except Exception:  # noqa: BLE001
                pass
            return json.dumps(_refuse("internal"))
        try:
            label = action if action in ACTIONS else "other"
            if result.get("success") is True:
                logger.info(
                    "av-events: record_intention action=%s source=%s held=%s published=%d refused=%s reason=%s",
                    label, result.get("source") or "-", held, 1 if result.get("published") else 0,
                    result.get("publish_refused") or "-", result.get("local_reason") or "-",
                )
            else:
                logger.info("av-events: record_intention action=%s refused=%s", label, result.get("error"))
        except Exception:  # noqa: BLE001
            pass
        return json.dumps(result)

    return record_intention_tool


def register_record_intention_tool(ctx: Any) -> bool:
    """Register the tool and its lineage listeners when the switch is on. True when registered."""
    if not switch_on():
        logger.debug("av-events: record_intention skipped=switch_off")
        return False
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        logger.info("av-events: record_intention skipped=no_register_tool")
        return False
    handler = make_handler()
    try:
        try:
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=handler,
                          description=TOOL_DESCRIPTION)
        except TypeError:
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=handler)
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: record_intention register_failed=%s", type(exc).__name__)
        return False
    register_hook = getattr(ctx, "register_hook", None)
    if callable(register_hook):
        for name, callback in LINEAGE_HOOKS.items():
            try:
                register_hook(name, callback)
            except Exception:  # noqa: BLE001 - a missing listener only holds more as ambient
                continue
    logger.info("av-events: record_intention registered")
    return True


__all__ = [
    "ACTIONS",
    "DEFAULT_MCP_URL",
    "DEFAULT_RATE_CAP",
    "INDEX_DEADLINE_S",
    "INDEX_TIMEOUT_S",
    "LINEAGE_HOOKS",
    "PUBLISH_RULE",
    "RATE_CAP_ENV",
    "REFUSALS",
    "SOURCES",
    "SWITCH",
    "TOOLSET",
    "TOOL_DESCRIPTION",
    "TOOL_NAME",
    "TOOL_SCHEMA",
    "held_reason",
    "index_tool_call",
    "make_handler",
    "map_path",
    "mirror_update",
    "publish_intent",
    "record_intention_answer",
    "register_record_intention_tool",
    "reserve_publish",
    "switch_on",
    "url_allowed",
]
