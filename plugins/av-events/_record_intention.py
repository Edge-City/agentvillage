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

**The wire: Index's REST API (DATA-249).** Index's MCP endpoint rejects every
MCP protocol version this module could send (`legacy: 'reject'`), so the
overlay's own writes go to REST (`intent.controller.ts`, under `/api`), with
the same `x-api-key`: `POST /api/intents {description, sourceType,
sourceId?}` (success `{intentId, networkIds, sourceType, sourceId}`), `PATCH
/api/intents/{id} {description}`, and `PATCH /api/intents/{id}/archive` with
no body. Headers `x-api-key`, `accept: application/json`, and
`content-type: application/json` when there is a body; nothing else (the
plugin never sent `x-index-surface`). The origin is `INDEX_API_URL`, else the
origin of a legacy `INDEX_MCP_URL` of the form `https://<host>/mcp`, else
`https://protocol.index.network` (`api_origin`); https only, plain http only
to a loopback host. An id in a path must be a UUID or a hex short id, and is
URL-encoded. Redirects refused, proxies ignored (`_core.NO_REDIRECT_OPENER`).
Status codes map to `publish_refused` in `status_code`: 422 is `rejected`,
anything else `http_<status>`. The `index_tool` observer still watches
Index's MCP tool names, which an agent may reach through Hermes's own client.

**Deadline and the ambiguous timeout.** Each socket operation is bounded by
`INDEX_TIMEOUT_S` and the whole request by `INDEX_DEADLINE_S` (30 s: Index's
`create_intent` runs a multi-stage verification graph that can take tens of
seconds). Past the deadline the capture is recorded locally with
`publish_refused: timeout`, and Index may still finish the write, so one
intention can then have two rows: this local one and the Index one the poller
sees. The data side reconciles under provisional ruling R11
(`eligibility_v3`): a `rejected` capture is ineligible (`index_rejected`); a
`timeout` capture is ineligible (`index_duplicate_timeout`) only when an
Index-side capture from the same tenant with the same `text_hash` falls
between the timed-out call's start and one hour after the capture (the poller
is timed only by Index's `createdAt`); every other code stays eligible.
Dogfood latency is measured before the switch goes on anywhere else.

**A rejected capture is not updated into a published one (M2).** The map
labels a local capture that Index refused as too vague (`refused: rejected`).
`action=update` on it is refused with `capture_again`: the agent captures the
clarified text as a new intention, and the rejected one stays ineligible
(`index_rejected`) and never publishes. A withdrawal of it is still allowed.
[Reversal: allow the update as a local-only change.]

**Switch.** Registered only when `AV_RECORD_INTENTION` is `1|true|yes|on`
(default off). Hermes loads `$HERMES_HOME/.env` into the process environment
at startup, so a change there takes effect after a gateway restart, in both
directions. The handler re-reads the switch from the process environment at
every call, which honours only a change made to `os.environ` itself.

**Who is speaking: the tool's own session lineage (refutation F3, ruling R10).**
Whether a call may publish is decided from lineage this module records in its
own hook listeners (`on_session_start` and `pre_api_request` give the platform,
`subagent_start` the parent). They are registered with the tool and do not go
through the collector's `hook_allowed`, `AV_EVENTS_ENABLED`, the breaker or a
degraded session, so turning telemetry off, disabling a telemetry hook or an
unload never loosens the gate. R10 makes it an allowlist: an explicit source
may publish only from a session (or the root of its delegation chain) seen on a
human-facing platform (`HUMAN_PLATFORMS`: the gateway's chat platforms plus
`cli`, `tui`, `desktop`). A `cron_` id or `platform=cron` anywhere in the chain
is `cron`; everything else (`api_server`, `webhook`, `batch`, `acp`, `curator`,
an empty platform, a plugin platform, a session never seen, a subagent of
unknown ancestry) is `unknown`. Either way the capture is held as ambient.
[Reversal F3: gate on `_is_cron_session` over the collector again. Reversal
R10: the cron/subagent denylist, any other seen platform may publish.]

**Held explicit captures leave a trace (M3).** When the lineage turns a
requested `message`/`onboarding`/`note` into ambient, the event carries
`publish_refused="held_cron"` or `"held_unknown"`. [Reversal: no code; the
event says only `source=ambient`.]

**Held updates (F4, M3).** In a held session `action=update` of a published id
never mirrors to Index; the local event carries `publish_refused` `held_cron` or
`held_unknown` and `source` ambient. A withdrawal may still mirror (it removes,
never asserts). [Reversal: mirror updates from any session.]

**Rate cap (M1, L2).** At most `AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR`
(default 20) Index `create_intent` attempts per rolling hour per tenant, counted
across processes in the local map (timestamps only). The clock is read inside
the map lock, a stamp is dropped only once it is older than the window (a
future stamp from a writer whose clock is ahead is kept), and no writer deletes
another's live stamps, so concurrent writers never exceed the cap. Over the cap
the capture is local with `publish_refused="rate_capped"`. A count that cannot
be read refuses as `rate_unavailable` (fail closed); a count that was read but
cannot be saved proceeds on the in-memory count, and `rate_count_failed` is
logged once per process. An attempt counts whether or not Index accepts it.
[Reversal M1: none needed; it is a correctness fix. Reversal L2: fail closed on
a save failure too. Cap: set it very large.]

**Fail open.** The handler never raises into Hermes. Logs carry codes, ids and
counts; never the intention's text, never the key.

**Local map (F5, R9 revised).** `$HERMES_HOME/av-events/intentions.json`
(0600), guarded by `fcntl.flock` on the sibling `intentions.json.lock` around
every read-modify-write: id -> `{published, source}`, `refused: rejected` for a
local capture Index rejected, plus `held_norm_hash`
for a held ambient entry only: sha256 of its text case-folded with whitespace
collapsed, used for this check alone and never emitted. It is replaced when the
held intention is updated and dropped when it is withdrawn. A capture that
would publish (explicit source, `publish` true, a session that may publish)
whose normalised text matches a held entry is recorded locally, not refused:
the event is emitted with `publish_refused="held_ambient_exists"` and the agent
is told a held intention is published only through confirmation. A personal
(`publish=false`) capture is never checked. [Reversal R9: drop the hash and
rely on the prompt.] A corrupt file is renamed aside to
`intentions.json.corrupt-<n>`, logged `map_corrupt`, and the map starts empty.
An update or withdrawal of an id not in the map mirrors nothing: its event is
ambient with `publish_refused="unknown_id"`.

Python 3.11, standard library only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
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
    hermes_home,
    is_redirect,
    register_literal_secret,
    uuid7,
)
from ._intentions import (
    LOCAL_REASONS,
    RECORD_INTENTION_TOOL,
    RESTRICTIVE_SOURCE,
    valid_id,
)

logger = logging.getLogger("av-events")

TOOL_NAME = RECORD_INTENTION_TOOL
TOOLSET = "av-events"
SWITCH = "AV_RECORD_INTENTION"
TRUTHY = frozenset({"1", "true", "yes", "on"})
#: Index's REST origin (DATA-249). `INDEX_API_URL` overrides it; see `api_origin`.
DEFAULT_API_URL = "https://protocol.index.network"
API_URL_ENV = "INDEX_API_URL"
#: Read only when `INDEX_API_URL` is unset: the installer's MCP URL, whose
#: origin is the REST origin (`https://<host>/mcp` -> `https://<host>`).
LEGACY_MCP_URL_ENV = "INDEX_MCP_URL"
#: Plain http is allowed only to these hosts (a local Index in development).
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
#: Per socket operation, and for the whole request (see the header).
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
    "capture_again": (
        "Not updated: Index did not accept this intention, and it stays unpublished. Capture the "
        "clarified text as a new intention (action=capture) instead; this one stays as it was."
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
    """An Index REST origin we may send the key to: https with a host, or plain
    http to a loopback host only; no credentials, query, fragment or path."""
    try:
        parts = urllib.parse.urlsplit(url)
        hostname = parts.hostname
        parts.port  # noqa: B018 - raises on a malformed port
    except ValueError:
        return False
    if not hostname or parts.username is not None or parts.password is not None:
        return False
    if parts.query or parts.fragment or parts.path not in ("", "/"):
        return False
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and hostname.lower() in LOOPBACK_HOSTS


def _origin_from_mcp_url(url: str) -> Optional[str]:
    """`https://<host>[:port]/mcp` -> `https://<host>[:port]`; anything else None."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    if parts.scheme != "https" or parts.path.rstrip("/") != "/mcp" or parts.query or parts.fragment:
        return None
    origin = f"https://{parts.netloc}"
    return origin if url_allowed(origin) else None


def api_origin() -> tuple[Optional[str], Optional[str]]:
    """`(origin, None)`, or `(None, "url_refused")`.

    `INDEX_API_URL` when set (it must pass `url_allowed`). Otherwise the
    origin of a legacy `INDEX_MCP_URL` when it is `https://<host>/mcp`, so a
    tenant the installer pointed at Index's dev server keeps writing there; an
    `INDEX_MCP_URL` of any other shape refuses rather than falling back to
    production. Neither set: `DEFAULT_API_URL`.
    """
    configured = env(API_URL_ENV).strip()
    if configured:
        return (configured.rstrip("/"), None) if url_allowed(configured) else (None, "url_refused")
    legacy = env(LEGACY_MCP_URL_ENV).strip()
    if legacy:
        origin = _origin_from_mcp_url(legacy)
        return (origin, None) if origin is not None else (None, "url_refused")
    return DEFAULT_API_URL, None


#: Tests replace this: seconds since the epoch, for the rate cap.
_clock: Callable[[], float] = time.time


# ---- Index over REST (DATA-249) -------------------------------------------

#: Tests replace this. Anything with `.open(request, timeout=...)`.
_OPENER: Any = NO_REDIRECT_OPENER

#: Index's three intent writes this module makes (`intent.controller.ts`,
#: mounted under `/api`). `{id}` is an intent id, validated and URL-encoded.
CREATE_PATH = "/api/intents"
UPDATE_PATH = "/api/intents/{id}"
ARCHIVE_PATH = "/api/intents/{id}/archive"

#: An id that may go into a path: a UUID, or the hex short id Index accepts.
INTENT_PATH_ID = re.compile(
    r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{4,32})$"
)


class IndexFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def status_code(status: int) -> str:
    """The `publish_refused` code for a non-2xx answer.

    422 is Index refusing the text (`intent_rejected`: too vague, or an edit it
    would not accept): `rejected`, which the map labels and the data side reads
    as `index_rejected`. Every other status is `http_<status>`: 400 a body we
    built wrong, 401/403 the key or a preparation receipt (never the resident's
    words), 404 an unknown intent, 409 an archived one, 503 Index's retryable
    `preparation_failed` (nothing was written), 500 anything else.
    """
    if is_redirect(status):
        return "redirect"
    if status == 422:
        return "rejected"
    return f"http_{status}"


def _send(url: str, key: str, method: str, body: Optional[dict], timeout: float) -> Any:
    """One request; the parsed JSON body of a 2xx answer, else `IndexFailure`.
    No exception text carries the URL, the key or the body."""
    headers = {"accept": "application/json", "x-api-key": key}
    data: Optional[bytes] = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 0) or 0)
            raw = response.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as exc:
        try:
            exc.read()
        except Exception:  # noqa: BLE001
            pass
        raise IndexFailure(status_code(int(getattr(exc, "code", 0) or 0))) from None
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
    if not 200 <= status < 300:
        raise IndexFailure(status_code(status))
    if len(raw) > MAX_BODY_BYTES:
        raise IndexFailure("too_large")
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw.strip() else {}
    except (UnicodeDecodeError, ValueError):
        raise IndexFailure("malformed") from None
    if not isinstance(parsed, dict):
        raise IndexFailure("malformed")
    return parsed


def _join(worker: threading.Thread, deadline: float) -> None:
    """How long the caller waits on the worker. Tests replace it: no wall clock."""
    worker.join(deadline)


def index_request(method: str, path: str, body: Optional[dict] = None, *, timeout: Optional[float] = None,
                  deadline: Optional[float] = None) -> tuple[Any, Optional[str]]:
    """`(json body, None)` or `(None, code)` for one Index REST write. Never
    raises. A `timeout` is ambiguous: Index may still finish the write after
    the thread is abandoned."""
    timeout = INDEX_TIMEOUT_S if timeout is None else timeout
    deadline = INDEX_DEADLINE_S if deadline is None else deadline
    key = env("INDEX_API_KEY")
    if not key:
        return None, "no_key"
    register_literal_secret(key)
    origin, code = api_origin()
    if origin is None:
        return None, code
    url = origin + path
    box: list = []

    def run() -> None:
        try:
            box.append((_send(url, key, method, body, timeout), None))
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


#: `sourceType` on every intent the overlay creates (DATA-149 decision A,
#: DATA-249 O4): Index stores it and the client-owned `sourceId` unchanged,
#: and the poller (DATA-246) reads them.
SOURCE_TYPE = "agentvillage"


def publish_intent(text: str, *, source_id: Optional[str] = None) -> tuple[Optional[str], Optional[str]]:
    """`POST /api/intents` -> `(Index's intent id, None)` or `(None, code)`.

    Body `{description, sourceType, sourceId?}` and nothing else (Index's
    schema is strict; we send neither `networkIds`, so the intent is shared in
    every network the resident belongs to, nor `preparationReceipt`, so Index
    prepares the text itself and refuses it with 422 when it is not ready).
    `description` is `text` exactly as given: the event's `text_hash` is the
    plain SHA-256 of the same string, and Index persists it verbatim, so the
    poller's hash of the stored payload matches (DATA-246). Every create
    carries `sourceType = "agentvillage"`. `sourceId` is sent only with
    `source_id`: a held intention published later passes its local uuid v7,
    which the poller's back-reference merges on. A stated capture passes none:
    its `intention_id` is Index's id, corroborated by id (DATA-249 O4). A
    publish counts as done only with a valid `intentId` in a 2xx body.
    """
    body: dict[str, Any] = {"description": text, "sourceType": SOURCE_TYPE}
    if source_id is not None:
        body["sourceId"] = source_id
    payload, code = index_request("POST", CREATE_PATH, body)
    if code is not None:
        return None, code
    intent_id = payload.get("intentId") if isinstance(payload, dict) else None
    if not isinstance(intent_id, str) or not valid_id(intent_id):
        return None, "malformed"
    return intent_id, None


def mirror_update(intent_id: str, *, description: Optional[str] = None, archive: bool = False) -> Optional[str]:
    """Mirror an edit or a withdrawal of a published intention to Index.

    An archive is `PATCH /api/intents/{id}/archive` with no body (archiving
    cannot be undone on Index). An edit is `PATCH /api/intents/{id}` with
    `{description}`. Neither takes a status. None on success, else a code;
    `id_invalid` when the id is not one Index could have issued (nothing is
    sent). With neither change, nothing is sent.
    """
    if not archive and description is None:
        return None
    if not isinstance(intent_id, str) or INTENT_PATH_ID.fullmatch(intent_id) is None:
        return "id_invalid"
    quoted = urllib.parse.quote(intent_id, safe="")
    if archive:
        _, code = index_request("PATCH", ARCHIVE_PATH.format(id=quoted))
    else:
        _, code = index_request("PATCH", UPDATE_PATH.format(id=quoted), {"description": description})
    return code


# ---- Session lineage (F3) --------------------------------------------------

#: Sessions and parents remembered; the oldest fall off first.
MAX_LINEAGE = 4096
#: How far up a chain of delegated subagents to look.
MAX_LINEAGE_DEPTH = 8
#: Hermes names a delegated child's platform `subagent` (`tools/delegate_tool.py`).
SUBAGENT_PLATFORM = "subagent"
CRON_PLATFORM = "cron"

#: R10: platforms where a person is speaking to the agent. Hermes's gateway
#: `Platform` enum (`gateway/config.py`) minus the machine-facing members
#: (`local`, `homeassistant`, `api_server`, `webhook`, `msgraph_webhook`,
#: `wecom_callback`, `relay`), plus the local interactive surfaces `cli`, `tui`
#: and `desktop`. The enum is open-ended (plugin platforms are created on
#: demand); a platform not listed here is held, fail closed.
#: [Reversal R10: the cron/subagent denylist, i.e. any seen platform other than
#: `cron` and `subagent` may publish.]
HUMAN_PLATFORMS = frozenset({
    "telegram", "discord", "whatsapp", "whatsapp_cloud", "slack", "signal", "mattermost",
    "matrix", "email", "sms", "dingtalk", "feishu", "wecom", "weixin", "bluebubbles",
    "qqbot", "yuanbao", "cli", "tui", "desktop",
})

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

    Fails closed: only a session (or the root of its delegation chain) seen on a
    platform in `HUMAN_PLATFORMS` may publish. A subagent inherits its root's
    allowance; a cron run anywhere in the chain is `cron`.
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
            return None if platform in HUMAN_PLATFORMS else "unknown"
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


#: The map key for a held ambient entry's normalised-text hash (R9 revised).
HELD_HASH_KEY = "held_norm_hash"


def held_norm_hash(text: str) -> str:
    """sha256 of the text case-folded with whitespace collapsed. Used for the
    held-text check only; never emitted (the event's `text_hash` is exact)."""
    return hashlib.sha256(" ".join(text.split()).casefold().encode("utf-8", errors="surrogatepass")).hexdigest()


def held_hash_exists(norm_hash: str) -> bool:
    try:
        entries = _load_map()
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: record_intention map_read_failed=%s", type(exc).__name__)
        return False
    return any(v.get(HELD_HASH_KEY) == norm_hash for v in entries.values())


def set_held_hash(intention_id: str, norm_hash: Optional[str]) -> None:
    """Replace (or, with None, drop) a known entry's held hash. Best effort."""
    try:
        with _Locked():
            entries, publishes = _load_locked()
            entry = entries.get(intention_id)
            if entry is None:
                return
            if norm_hash is None:
                if HELD_HASH_KEY not in entry:
                    return
                entry.pop(HELD_HASH_KEY, None)
            else:
                entry[HELD_HASH_KEY] = norm_hash
            _save_locked(entries, publishes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: record_intention map_write_failed=%s", type(exc).__name__)


def remember(
    intention_id: str, *, published: bool, source: str, norm_hash: Optional[str] = None,
    refused: Optional[str] = None,
) -> None:
    """Best effort: a map that cannot be written costs a later Index mirror, not the capture."""
    try:
        with _Locked():
            entries, publishes = _load_locked()
            entries.pop(intention_id, None)
            entry: dict[str, Any] = {"published": published, "source": source}
            # R9: the hash only for a held ambient entry.
            if norm_hash is not None and source == RESTRICTIVE_SOURCE and not published:
                entry[HELD_HASH_KEY] = norm_hash
            # M2: a label (a code), for a local capture Index rejected.
            if refused == "rejected" and not published:
                entry["refused"] = refused
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


_RATE_WARNED = False


def _warn_rate_once(exc: BaseException) -> None:
    global _RATE_WARNED
    if not _RATE_WARNED:
        _RATE_WARNED = True
        logger.warning("av-events: record_intention rate_count_failed=%s", type(exc).__name__)


def reserve_publish() -> Optional[str]:
    """Count one `create_intent` attempt in the rolling hour. None when counted,
    `rate_capped` when the hour is full, `rate_unavailable` when the count
    cannot be read (fails closed, visibly).

    M1: the clock is read inside the lock, and a stamp is dropped only when it
    is older than the window; a stamp in the future (another writer's clock
    ahead of ours) is kept, so no writer ever deletes another's attempts.
    L2: when the count was read but cannot be saved, the attempt proceeds on
    the in-memory count, and the failure is logged once per process.
    """
    cap = rate_cap()
    try:
        with _Locked():
            try:
                entries, publishes = _load_locked()
            except Exception as exc:  # noqa: BLE001
                _warn_rate_once(exc)
                return "rate_unavailable"
            now = float(_clock())
            recent = [t for t in publishes if t > now - RATE_WINDOW_S]
            if len(recent) >= cap:
                return "rate_capped"
            recent.append(now)
            try:
                _save_locked(entries, recent)
            except Exception as exc:  # noqa: BLE001
                _warn_rate_once(exc)
            return None
    except Exception as exc:  # noqa: BLE001 - the lock itself could not be taken
        _warn_rate_once(exc)
        return "rate_unavailable"


# ---- Actions --------------------------------------------------------------


def _publish_precheck() -> Optional[str]:
    """`no_key` / `url_refused` before an attempt is counted against the cap."""
    if not env("INDEX_API_KEY"):
        return "no_key"
    return api_origin()[1]


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
    held_code: Optional[str] = None
    if held is not None:
        # No participant is known to be speaking. M3: an explicit source the
        # lineage overrode leaves a trace on the event.
        if source in EXPLICIT_SOURCES:
            held_code = f"held_{held}"
        source = RESTRICTIVE_SOURCE
    publish = True
    if args.get("publish") is not None:
        parsed = _bool(args.get("publish"))
        if parsed is None:
            return _refuse("publish_invalid")
        publish = parsed
    norm = held_norm_hash(text)

    # `action` tells the observer what was done when the call left it to the default.
    result: dict[str, Any] = {"success": True, "action": "capture", "source": source}
    if source == RESTRICTIVE_SOURCE:
        intention_id = uuid7()
        result.update(intention_id=intention_id, index_intent_id=None, published=False, held=True)
        if held_code is not None:
            result["publish_refused"] = held_code
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
    elif held_hash_exists(norm):
        # R9 revised: the same intention is held as ambient. Record this
        # capture locally (the event is emitted) and never publish around the
        # confirmation.
        intention_id = uuid7()
        result.update(intention_id=intention_id, index_intent_id=None, published=False,
                      publish_refused="held_ambient_exists")
        result["message"] = (
            f"Recorded locally (intention_id {intention_id}), not published: the same intention is already "
            "held as ambient, and a held intention is published only through the resident's confirmation. "
            "Do not publish it another way."
        )
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
        norm_hash=norm if source == RESTRICTIVE_SOURCE else None,
        refused=result.get("publish_refused"),
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

    if action == "update" and entry.get("refused") == "rejected":
        return _refuse("capture_again")
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
    if not published and entry.get("source") == RESTRICTIVE_SOURCE:
        # R9 revised: a held entry's hash follows its text, and goes with it.
        set_held_hash(intention_id, held_norm_hash(text) if action == "update" and text is not None else None)
    code: Optional[str] = None
    if published:
        if action == "update" and held is not None:
            code = f"held_{held}"  # F4/M3: a held session never overwrites a live intent
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
    elif code.startswith("held_"):
        result["message"] = f"{verb} intention {intention_id} locally; this session cannot change it on Index."
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
    "ARCHIVE_PATH",
    "CREATE_PATH",
    "DEFAULT_API_URL",
    "DEFAULT_RATE_CAP",
    "INDEX_DEADLINE_S",
    "INDEX_TIMEOUT_S",
    "LINEAGE_HOOKS",
    "PUBLISH_RULE",
    "RATE_CAP_ENV",
    "REFUSALS",
    "SOURCES",
    "SOURCE_TYPE",
    "SWITCH",
    "TOOLSET",
    "TOOL_DESCRIPTION",
    "TOOL_NAME",
    "TOOL_SCHEMA",
    "UPDATE_PATH",
    "api_origin",
    "held_reason",
    "index_request",
    "make_handler",
    "map_path",
    "mirror_update",
    "publish_intent",
    "record_intention_answer",
    "register_record_intention_tool",
    "reserve_publish",
    "status_code",
    "switch_on",
    "url_allowed",
]
