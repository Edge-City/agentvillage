"""Intention capture: which tool calls record an intention, and what they say.

Pure functions over one `post_tool_call` payload. Nothing here buffers, hashes
into an envelope, or knows about sessions — `__init__` does that — so the whole
decision "is this a recorded intention, and which one" is testable in isolation.

Spec §4.1 (`intention.captured/updated/withdrawn`) and §7.1 ("Intention
capture"). Two producers inside the sandbox:

* **Index MCP tools.** `create_intent` → `intention.captured`, `update_intent`
  → `intention.updated` (or `intention.withdrawn` when it archives), and
  `delete_intent` → `intention.withdrawn`. The intention id is Index's intent id:
  from the result for a create, from the arguments for an update or delete.
* **`record_intention`**, for intentions the agent keeps locally. Its id is a
  uuid v7 minted by the plugin at capture unless the call already names one.

No natural-language detection anywhere: an intention exists only when one of
these tools records it, and only when the tool says it succeeded.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
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

#: `update_intent(status=...)` values that take an intention out of the funnel.
#: The Index skill archives stale signals with `status="archived"`
#: (`skills/index-network/heartbeat.md`); the other two are defensive.
WITHDRAWN_STATUSES = frozenset({"archived", "deleted", "withdrawn"})

#: §4.1 `source`. `index` belongs to the poller; the plugin writes the rest.
RECORD_SOURCES = ("message", "onboarding", "ambient")
DEFAULT_SOURCE = "message"

#: `record_intention(action=...)` spellings.
_RECORD_ACTIONS = {
    "capture": "intention.captured",
    "captured": "intention.captured",
    "create": "intention.captured",
    "update": "intention.updated",
    "updated": "intention.updated",
    "withdraw": "intention.withdrawn",
    "withdrawn": "intention.withdrawn",
    "delete": "intention.withdrawn",
    "retract": "intention.withdrawn",
}

#: A tool result larger than this is not parsed. An intent write returns a few
#: hundred bytes; anything this size is not one, and parsing it would spend the
#: hook's 50 ms budget on the agent's time.
MAX_RESULT_CHARS = 256 * 1024

#: Hermes statuses on `post_tool_call` that mean the tool did not do its work.
_FAILED_STATUSES = frozenset({"error", "blocked"})

_ID_KEYS = ("id", "intentId", "intent_id")


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


def _maybe_json(value: Any) -> Any:
    if isinstance(value, str):
        if len(value) > MAX_RESULT_CHARS:
            return None
        stripped = value.strip()
        if not stripped or stripped[0] not in "{[":
            return value
        try:
            return json.loads(stripped)
        except (ValueError, RecursionError):
            return value
    return value


def unwrap_result(result: Any) -> Any:
    """The tool's own payload, out of Hermes's wrapping.

    An MCP result reaches `post_tool_call` as a JSON string
    `{"result": <text>}`, where `<text>` is the server's text content — for
    Index itself a JSON document `{"success": ..., "data": ...}` — plus
    `structuredContent` when the server sent one (`tools/mcp_tool.py` at
    `v2026.8.31`). Structured content wins: it is the machine-readable copy.
    """
    outer = _maybe_json(result)
    if isinstance(outer, dict) and ("result" in outer or "structuredContent" in outer):
        structured = outer.get("structuredContent")
        if isinstance(structured, dict):
            return structured
        return _maybe_json(outer.get("result"))
    return outer


def result_succeeded(status: Any, payload: Any) -> bool:
    """Whether the tool reports that it did what it was asked.

    Hermes's own `status` catches exceptions, plugin blocks and top-level
    `{"error": ...}` results. It cannot see inside Index's text content, which
    reports a refusal ("too vague") as `{"success": false, ...}` with a Hermes
    status of `ok` — so that is checked here too.
    """
    if str(status or "ok").lower() in _FAILED_STATUSES:
        return False
    if isinstance(payload, dict):
        if payload.get("success") is False:
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


def result_intents(payload: Any) -> list[tuple[Optional[str], Optional[str]]]:
    """`(intent_id, summary)` for each intent a result describes.

    The Index result shape for a write is not pinned anywhere we can read, so
    this accepts the shapes Index uses on its read path (`read_intents`:
    `data.intents[]` with `id` and `summary`) and the obvious singular forms:
    `data.intent`, `data` itself, or the top level.
    """
    data = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
    if isinstance(data, dict):
        many = data.get("intents")
        if isinstance(many, list):
            return [(_first_id(item), _text(item.get("summary"))) for item in many if isinstance(item, dict)]
        one = data.get("intent")
        if isinstance(one, dict):
            return [(_first_id(one), _text(one.get("summary")))]
        return [(_first_id(data), _text(data.get("summary")))]
    if isinstance(data, list):
        return [(_first_id(item), _text(item.get("summary"))) for item in data if isinstance(item, dict)]
    return []


# --------------------------------------------------------------------------
# Planning
# --------------------------------------------------------------------------


def _conditional(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _args_id(args: dict, *keys: str) -> Optional[str]:
    for key in keys:
        value = args.get(key)
        if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value):
            return str(value)
    return None


def plan_index(tool: str, args: dict, payload: Any) -> list[IntentionCall]:
    """Events for a successful Index `create_intent` / `update_intent` / `delete_intent`.

    `source` is `message`: the catalogue's row for plugin capture (measurement
    catalogue §A, "Messages to agents"). `index` is the poller's source.
    """
    event_type = INDEX_INTENT_TOOLS[tool]
    text = _text(args.get("description"))
    found = result_intents(payload)

    if tool == "create_intent":
        # A successful create with no id we can read still recorded an
        # intention. It gets a plugin-minted id (the caller mints it) and a
        # null `index_intent_id`, and `core.intention_links` joins it to the
        # poller's copy by hash — better than losing the capture.
        found = found or [(None, None)]
        return [
            IntentionCall(
                event_type,
                intention_id=intent_id,
                index_intent_id=intent_id,
                text=text,
                summary=summary,
                capture_path="index_tool",
            )
            for intent_id, summary in found
        ]

    intent_id = _args_id(args, *_ID_KEYS) or next((i for i, _ in found if i), None)
    if intent_id is None:
        # An update or a delete of an intention we cannot name joins nothing.
        return []
    status = _text(args.get("status"))
    if tool == "update_intent" and status and status.lower() in WITHDRAWN_STATUSES:
        event_type = "intention.withdrawn"
    summary = next((s for i, s in found if s and (i is None or i == intent_id)), None)
    if event_type == "intention.withdrawn":
        text, summary = None, None
    return [
        IntentionCall(
            event_type,
            intention_id=intent_id,
            index_intent_id=intent_id,
            text=text,
            summary=summary,
            capture_path="index_tool",
            index_status=status,
        )
    ]


def _result_intention_id(obj: Any) -> Optional[str]:
    if not isinstance(obj, dict):
        return None
    data = obj.get("data")
    return _args_id(obj, "intention_id") or (_args_id(data, "intention_id") if isinstance(data, dict) else None)


def plan_record(args: dict, payload: Any, outer: Any = None) -> list[IntentionCall]:
    """Events for a `record_intention` call.

    Contract (the tool surface itself is not in this repo yet — README
    "Intention capture"): `text` (or `description`), optional `summary`,
    `source` ∈ `message|onboarding|ambient`, `conditional`, `intention_id` to
    update or withdraw an earlier one, `action` ∈ `capture|update|withdraw`,
    and `index_intent_id` when the agent also knows the Index copy's id. A
    result carrying `intention_id` names the intention; otherwise the caller
    mints one for a capture. `outer` is the result before unwrapping, for a
    native tool that returns `{"result": ..., "intention_id": ...}`.
    """
    result_id = _result_intention_id(payload) or _result_intention_id(outer)
    arg_id = _args_id(args, "intention_id")
    intention_id = arg_id or result_id

    action = str(args.get("action") or "").strip().lower()
    event_type = _RECORD_ACTIONS.get(action) or ("intention.updated" if arg_id else "intention.captured")
    if event_type != "intention.captured" and intention_id is None:
        return []

    source = str(args.get("source") or "").strip().lower()
    if source not in RECORD_SOURCES:
        source = DEFAULT_SOURCE

    text = _text(args.get("text")) or _text(args.get("description"))
    summary = _text(args.get("summary"))
    if event_type == "intention.withdrawn":
        text, summary = None, None
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


def plan(tool_name: Any, args: Any, result: Any, status: Any) -> list[IntentionCall]:
    """Every intention event one `post_tool_call` implies. Empty when none.

    Never raises on a malformed result: an unparseable payload is simply not an
    intention we can name. A failed, blocked or refused call records nothing —
    the agent may retry with a new call, and only the one that lands counts.
    """
    kind = classify_tool(tool_name)
    if kind is None:
        return []
    safe_args = args if isinstance(args, dict) else {}
    payload = unwrap_result(result)
    if not result_succeeded(status, payload):
        return []
    if kind == "record":
        return plan_record(safe_args, payload, _maybe_json(result))
    _, tool = split_tool_name(tool_name)
    return plan_index(tool, safe_args, payload)


__all__ = [
    "INDEX_INTENT_TOOLS",
    "RECORD_INTENTION_TOOL",
    "RECORD_SOURCES",
    "WITHDRAWN_STATUSES",
    "IntentionCall",
    "classify_tool",
    "plan",
    "result_intents",
    "split_tool_name",
    "unwrap_result",
]
