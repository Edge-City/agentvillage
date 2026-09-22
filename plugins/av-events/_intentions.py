"""Intention capture: which tool calls record an intention, and what they say.

Pure functions over one `post_tool_call` payload. Nothing here buffers, hashes
into an envelope, or knows about sessions — `__init__` does that and passes in
the one session fact the rules need (whether it is a cron run) — so the whole
decision "is this a recorded intention, and which one" is testable in isolation.

Spec §4.1 (`intention.captured/updated/withdrawn`) and §7.1 ("Intention
capture"). Two producers inside the sandbox:

* **Index MCP tools.** `create_intent` → `intention.captured`, `update_intent`
  → `intention.updated` (or `intention.withdrawn` when it archives), and
  `delete_intent` → `intention.withdrawn`. The intention id is Index's intent id:
  from the result for a create, from the arguments for an update or delete. A
  create whose result does not name the intent records nothing.
* **`record_intention`**, for intentions the agent keeps locally. Its id comes
  from the call, else from the tool's result, else it is a uuid v7 minted by
  the plugin at capture.

No natural-language detection anywhere: an intention exists only when one of
these tools records it, and only when the tool says it succeeded.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

#: Index tool (bare name) -> the event it produces when it succeeds.
#: `update_intent` is re-typed to `withdrawn` when it archives the intent.
INDEX_INTENT_TOOLS: dict[str, str] = {
    "create_intent": "intention.captured",
    "update_intent": "intention.updated",
    "delete_intent": "intention.withdrawn",
}

#: The overlay tool for intentions the agent keeps locally (spec §7.1).
RECORD_INTENTION_TOOL = "record_intention"

#: Hermes registers an MCP tool as `mcp__<server>__<tool>` (`tools/mcp_tool.py`,
#: `MCP_TOOL_NAME_PREFIX`, at `v2026.8.31`). The installer names the Index
#: server `index` (`install/install_index.ts`).
MCP_PREFIX = "mcp__"
INDEX_SERVER = "index"

#: The Index statuses `index_status` may carry. Anything else is `other`.
INDEX_STATUSES = frozenset({"active", "archived", "deleted", "withdrawn", "completed", "unknown"})
OTHER_STATUS = "other"

#: Statuses that take an intention out of the funnel. The Index skill archives
#: stale signals with `status="archived"` (`skills/index-network/heartbeat.md`).
WITHDRAWN_STATUSES = frozenset({"archived", "deleted", "withdrawn"})

#: §4.1 `source`. `index` belongs to the poller; the plugin writes the rest.
RECORD_SOURCES = ("message", "onboarding", "ambient")
#: Index calls outside a cron run.
DEFAULT_SOURCE = "message"
#: Cron runs, and any `record_intention` source that is missing or unknown:
#: the most restrictive value, since `ambient` enters the funnel only after
#: the participant ratifies it.
RESTRICTIVE_SOURCE = "ambient"

#: `record_intention(action=...)` -> event. Any other action records nothing.
_RECORD_ACTIONS = {
    "capture": "intention.captured",
    "update": "intention.updated",
    "archive": "intention.withdrawn",
    "withdraw": "intention.withdrawn",
    "delete": "intention.withdrawn",
}

#: A tool result larger than this is not parsed. An intent write returns a few
#: hundred bytes; anything this size is not one, and parsing it would spend the
#: hook's 50 ms budget on the agent's time.
MAX_RESULT_CHARS = 256 * 1024

#: The only Hermes `post_tool_call` statuses that mean the tool did its work.
#: Everything else — `error`, `blocked`, `timeout`, `cancelled`, and whatever
#: Hermes adds next — records nothing.
_OK_STATUSES = frozenset({"ok", ""})

_ID_KEYS = ("id", "intentId", "intent_id")

#: Every id that goes into an envelope or a payload must look like an id.
ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

_DECODER = json.JSONDecoder()


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and ID_PATTERN.fullmatch(value) is not None


class IntentionCall:
    """One intention event implied by a tool call, before hashing."""

    __slots__ = (
        "event_type",
        "intention_id",
        "index_intent_id",
        "text",
        "summary",
        "source",
        "conditional",
        "capture_path",
        "index_status",
    )

    def __init__(
        self,
        event_type: str,
        *,
        intention_id: Optional[str],
        index_intent_id: Optional[str] = None,
        text: Optional[str] = None,
        summary: Optional[str] = None,
        source: str = DEFAULT_SOURCE,
        conditional: Optional[bool] = None,
        capture_path: str,
        index_status: Optional[str] = None,
    ) -> None:
        self.event_type = event_type
        self.intention_id = intention_id
        self.index_intent_id = index_intent_id
        self.text = text
        self.summary = summary
        self.source = source
        self.conditional = conditional
        self.capture_path = capture_path
        self.index_status = index_status


# --------------------------------------------------------------------------
# Tool names
# --------------------------------------------------------------------------


def split_tool_name(name: Any) -> tuple[Optional[str], str]:
    """`mcp__index__create_intent` -> ("index", "create_intent"); bare -> (None, name)."""
    text = str(name or "")
    if text.startswith(MCP_PREFIX):
        server, sep, tool = text[len(MCP_PREFIX) :].partition("__")
        if sep and tool:
            return server, tool
    return None, text


def classify_tool(name: Any) -> Optional[str]:
    """`"index"`, `"record"`, or None when the tool records no intention.

    Cheap by design: this runs on every `post_tool_call`, and for every tool
    that is not one of these four it is the only work the intention path does.
    """
    server, tool = split_tool_name(name)
    if tool == RECORD_INTENTION_TOOL:
        # Whoever ends up registering it — the overlay, this plugin, an MCP.
        return "record"
    if tool in INDEX_INTENT_TOOLS and (server is None or server == INDEX_SERVER):
        # Another MCP server that happens to call a tool `create_intent` is not
        # Index, and its "intentions" are not ours to count.
        return "index"
    return None


# --------------------------------------------------------------------------
# Result parsing
# --------------------------------------------------------------------------


def _first_json(value: Any) -> Any:
    """The first JSON object in a string, or the value itself if there is none.

    Hermes joins an MCP result's text blocks with a newline, so a result can be
    prose, then a JSON object, then more text. Only a line that *starts* with
    `{` (after indentation) is tried, from that line on, and the first one that
    decodes wins. A `{` inside a sentence ("A good signal looks like {...}") is
    never read as a result. A string over `MAX_RESULT_CHARS` is not read at all
    and yields None.
    """
    if not isinstance(value, str):
        return value
    if len(value) > MAX_RESULT_CHARS:
        return None
    offset = 0
    for line in value.split("\n"):
        indent = len(line) - len(line.lstrip())
        if line[indent:indent + 1] == "{":
            try:
                parsed, _ = _DECODER.raw_decode(value, offset + indent)
            except (ValueError, RecursionError):
                pass
            else:
                return parsed
        offset += len(line) + 1
    return value


def unwrap_result(result: Any) -> Any:
    """The tool's own payload, out of Hermes's wrapping.

    An MCP result reaches `post_tool_call` as a JSON string
    `{"result": <text>}`, where `<text>` is the server's text content — for
    Index itself a JSON document `{"success": ..., "data": ...}` — plus
    `structuredContent` when the server sent one (`tools/mcp_tool.py` at
    `v2026.8.31`). Structured content wins: it is the machine-readable copy.
    """
    outer = _first_json(result)
    if isinstance(outer, dict) and ("result" in outer or "structuredContent" in outer):
        structured = outer.get("structuredContent")
        if isinstance(structured, dict):
            return structured
        return _first_json(outer.get("result"))
    return outer


def result_succeeded(status: Any, payload: Any) -> bool:
    """Whether the tool reports that it did what it was asked.

    Hermes's `status` must be `ok` (or empty). Hermes cannot see inside Index's
    text content, which reports a refusal ("too vague") as `{"success": false}`
    with a status of `ok`, so a `success` key, when present, must be the
    boolean `true` — the string `"false"`, `null`, `1` all reject.
    """
    if status is not None and str(status).strip().lower() not in _OK_STATUSES:
        return False
    if isinstance(payload, dict):
        if "success" in payload and payload["success"] is not True:
            return False
        if payload.get("error") and not payload.get("data"):
            return False
    return True


def _first_id(obj: Any) -> Optional[str]:
    if not isinstance(obj, dict):
        return None
    for key in _ID_KEYS:
        value = obj.get(key)
        if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value):
            return str(value)
    return None


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def result_intent(payload: Any) -> Optional[dict]:
    """The one intent object a write result describes, or None.

    Accepted shapes only: `data.intent`, `data.intents` holding exactly one
    item, or `intent` at the top (a `structuredContent` copy). Anything else —
    several intents, a bare `data`, an id at the top level — names no intent.
    """
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if isinstance(data, dict):
        one = data.get("intent")
        if isinstance(one, dict):
            return one
        many = data.get("intents")
        if isinstance(many, list) and len(many) == 1 and isinstance(many[0], dict):
            return many[0]
    top = payload.get("intent")
    if isinstance(top, dict):
        return top
    return None


def normalise_status(value: Any) -> Optional[str]:
    """Strip and case-fold a status, and fold anything unlisted into `other`."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if not text:
        return None
    return text if text in INDEX_STATUSES else OTHER_STATUS


# --------------------------------------------------------------------------
# Planning
# --------------------------------------------------------------------------


def _conditional(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _args_id(args: Any, *keys: str) -> Optional[str]:
    if not isinstance(args, dict):
        return None
    for key in keys:
        value = args.get(key)
        if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value):
            return str(value)
    return None


def plan_index(tool: str, args: dict, payload: Any, *, cron: bool = False) -> list[IntentionCall]:
    """Events for a successful Index `create_intent` / `update_intent` / `delete_intent`.

    `source` is `ambient` in a cron run (the nightly memory-signal sync calls
    `create_intent` with no participant in the loop) and `message` otherwise.
    """
    source = RESTRICTIVE_SOURCE if cron else DEFAULT_SOURCE
    text = _text(args.get("description"))
    intent = result_intent(payload)

    if tool == "create_intent":
        # A create is only an intention we can join if Index names it.
        if not isinstance(payload, dict):
            return []
        intent_id = _first_id(intent)
        if intent_id is None:
            return []
        return [
            IntentionCall(
                "intention.captured",
                intention_id=intent_id,
                index_intent_id=intent_id,
                text=text,
                summary=_text(intent.get("summary")) if intent else None,
                source=source,
                capture_path="index_tool",
                index_status=normalise_status(intent.get("status")) if intent else None,
            )
        ]

    intent_id = _args_id(args, *_ID_KEYS)
    if intent_id is None:
        # An update or a delete of an intention we cannot name joins nothing.
        return []
    same_intent = intent is not None and _first_id(intent) in (None, intent_id)
    arg_status = normalise_status(args.get("status"))
    result_status = normalise_status(intent.get("status")) if intent is not None and same_intent else None
    # Either side saying the intent is gone is a withdrawal.
    if arg_status in WITHDRAWN_STATUSES:
        status: Optional[str] = arg_status
    elif result_status in WITHDRAWN_STATUSES:
        status = result_status
    else:
        status = arg_status or result_status

    if tool == "delete_intent" or status in WITHDRAWN_STATUSES:
        return [
            IntentionCall(
                "intention.withdrawn",
                intention_id=intent_id,
                index_intent_id=intent_id,
                source=source,
                capture_path="index_tool",
                index_status=status,
            )
        ]
    if text is None:
        # A status-only update changes no text: nothing new to version.
        return []
    summary = _text(intent.get("summary")) if intent is not None and same_intent else None
    return [
        IntentionCall(
            "intention.updated",
            intention_id=intent_id,
            index_intent_id=intent_id,
            text=text,
            summary=summary,
            source=source,
            capture_path="index_tool",
            index_status=status,
        )
    ]


def _result_intention_id(obj: Any) -> Optional[str]:
    if not isinstance(obj, dict):
        return None
    data = obj.get("data")
    return _args_id(obj, "intention_id") or (_args_id(data, "intention_id") if isinstance(data, dict) else None)


def plan_record(args: dict, payload: Any, outer: Any = None, *, cron: bool = False) -> list[IntentionCall]:
    """Events for a `record_intention` call. Contract: README "Intention capture".

    `action` ∈ `capture|update|archive|withdraw|delete`; any other action
    records nothing. With no `action`, a call naming an `intention_id` is an
    update and a call naming none records nothing. `capture` on an existing id
    is an update. `outer` is the result before unwrapping, for a native tool
    that returns `{"result": ..., "intention_id": ...}`.
    """
    arg_id = _args_id(args, "intention_id")
    raw_action = args.get("action")
    action = raw_action.strip().lower() if isinstance(raw_action, str) else ""

    if action:
        event_type = _RECORD_ACTIONS.get(action)
        if event_type is None:
            return []
    elif arg_id:
        event_type = "intention.updated"
    else:
        return []
    if event_type == "intention.captured" and arg_id:
        event_type = "intention.updated"

    intention_id = arg_id
    if event_type == "intention.captured":
        intention_id = _result_intention_id(payload) or _result_intention_id(outer)
    elif intention_id is None:
        return []

    source = str(args.get("source") or "").strip().lower()
    if cron or source not in RECORD_SOURCES:
        source = RESTRICTIVE_SOURCE

    text = _text(args.get("text")) or _text(args.get("description"))
    summary = _text(args.get("summary"))
    if event_type == "intention.withdrawn":
        text, summary = None, None
    elif event_type == "intention.updated" and text is None and summary is None:
        return []
    return [
        IntentionCall(
            event_type,
            intention_id=intention_id,
            index_intent_id=_args_id(args, "index_intent_id"),
            text=text,
            summary=summary,
            source=source,
            conditional=_conditional(args.get("conditional")),
            capture_path="record_intention",
        )
    ]


def plan(tool_name: Any, args: Any, result: Any, status: Any, *, cron: bool = False) -> list[IntentionCall]:
    """Every intention event one `post_tool_call` implies. Empty when none.

    Never raises on a malformed result: an unparseable payload is simply not an
    intention we can name. A failed, blocked or refused call records nothing —
    the agent may retry with a new call, and only the one that lands counts.
    `cron` is whether the call ran in a cron session.
    """
    kind = classify_tool(tool_name)
    if kind is None:
        return []
    safe_args = args if isinstance(args, dict) else {}
    payload = unwrap_result(result)
    if not result_succeeded(status, payload):
        return []
    if kind == "record":
        return plan_record(safe_args, payload, _first_json(result), cron=cron)
    _, tool = split_tool_name(tool_name)
    return plan_index(tool, safe_args, payload, cron=cron)


__all__ = [
    "ID_PATTERN",
    "INDEX_INTENT_TOOLS",
    "INDEX_STATUSES",
    "RECORD_INTENTION_TOOL",
    "RECORD_SOURCES",
    "WITHDRAWN_STATUSES",
    "IntentionCall",
    "classify_tool",
    "normalise_status",
    "plan",
    "result_intent",
    "split_tool_name",
    "unwrap_result",
    "valid_id",
]
