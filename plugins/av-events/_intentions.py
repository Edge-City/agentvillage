"""Intention capture: which tool calls record an intention, and what they say.

Pure functions over one `post_tool_call` payload. Nothing here buffers, hashes
into an envelope, or knows about sessions — `__init__` does that and passes in
the one session fact the rules need (whether it is a cron run) — so the whole
decision "is this a recorded intention, and which one" is testable in isolation.

Spec §4.1 (`intention.captured/updated/withdrawn`) and §7.1 ("Intention
capture"). Two producers inside the sandbox:

* **Index MCP tools** (DATA-249, Index `main` `mcp.tools.ts`; the overlay's
  copy of their input schemas is `index_mcp_intent_tools.json`).
  `create_intent` → `intention.captured`; `update_intent` with a new
  `description` → `intention.updated`; `pause_intent` / `resume_intent` →
  `intention.updated` with `index_status` `paused` / `active`; `archive_intent`
  → `intention.withdrawn` with `index_status` `archived`. The intention id is
  Index's intent id: from the result for a create (`intentId`), else from the
  `intentId` argument, or from the result when Index resolved a short id prefix
  to the full id. A create whose result does not name the intent records
  nothing. `delete_intent` is kept only as a legacy alias (Index has no such
  tool today; an older Index surface did): a successful one is a withdrawal.
* **`record_intention`**, the overlay's front door (DATA-212, `_record_intention.py`).
  Its id comes from the call, else from the tool's result, else it is a uuid v7
  minted by the plugin at capture. The tool publishes to Index itself, over its
  own HTTP client and not through a Hermes MCP tool call, so a published
  capture is observed here once, as `record_intention`, with the Index id the
  tool's result names.

No natural-language detection anywhere: an intention exists only when one of
these tools records it, and only when the tool says it succeeded.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

#: Index tool (bare name) -> the event it produces when it succeeds. Index's
#: intent tools are `list_intents`, `get_intent`, `create_intent`,
#: `update_intent`, `pause_intent`, `resume_intent` and `archive_intent`; the
#: two reads record nothing. `update_intent` takes no status (archiving is
#: `archive_intent`), but a legacy `status` argument or an archived result is
#: still read as a withdrawal, so an older Index surface is not miscounted.
INDEX_INTENT_TOOLS: dict[str, str] = {
    "create_intent": "intention.captured",
    "update_intent": "intention.updated",
    "pause_intent": "intention.updated",
    "resume_intent": "intention.updated",
    "archive_intent": "intention.withdrawn",
    # Legacy alias, not an Index tool today (DATA-249). Kept rather than
    # removed: it costs nothing, and an Index server still on the older
    # surface would otherwise lose its withdrawals. Handled exactly as
    # `archive_intent`, with `index_status` `deleted`.
    "delete_intent": "intention.withdrawn",
}

#: The status a successful lifecycle tool leaves the intent in. Index's wire
#: status is only `active | paused`; an archive is `archivedAt` set.
LIFECYCLE_STATUS: dict[str, str] = {
    "pause_intent": "paused",
    "resume_intent": "active",
    "archive_intent": "archived",
    "delete_intent": "deleted",
}

#: The overlay tool for intentions the agent keeps locally (spec §7.1).
RECORD_INTENTION_TOOL = "record_intention"

#: Hermes registers an MCP tool as `mcp__<server>__<tool>` (`tools/mcp_tool.py`,
#: `MCP_TOOL_NAME_PREFIX`, at `v2026.8.31`). The installer names the Index
#: server `index` (`install/install_index.ts`).
MCP_PREFIX = "mcp__"
INDEX_SERVER = "index"

#: The Index statuses `index_status` may carry. Anything else is `other`.
#: `paused` (DATA-249) is Index's own, and paused is not withdrawn.
INDEX_STATUSES = frozenset({"active", "paused", "archived", "deleted", "withdrawn", "completed", "unknown"})
OTHER_STATUS = "other"

#: Statuses that take an intention out of the funnel. Index archives with
#: `archive_intent` (the Index skill calls it only after the user says yes,
#: `skills/index-network/tools.md`); `paused` is not one of them.
WITHDRAWN_STATUSES = frozenset({"archived", "deleted", "withdrawn"})

#: §4.1 `source`. `index` belongs to the poller; the plugin writes the rest.
#: `note` (DATA-212, ambient-intents spec §4): the resident's own words captured
#: from their notes tool; it publishes by default like `message`.
RECORD_SOURCES = ("message", "onboarding", "note", "ambient")
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

#: Lines starting with `{` tried as JSON before a result is given up on.
MAX_JSON_ATTEMPTS = 64

#: The only Hermes `post_tool_call` statuses that mean the tool did its work.
#: Everything else — `error`, `blocked`, `timeout`, `cancelled`, and whatever
#: Hermes adds next — records nothing.
_OK_STATUSES = frozenset({"ok", ""})

_ID_KEYS = ("id", "intentId", "intent_id")
#: An intent tool's id argument: Index names it `intentId`; the others are legacy.
_ARG_ID_KEYS = ("intentId", "id", "intent_id")
#: The key Index's create, pause, resume and archive results name the intent by.
RESULT_INTENT_ID_KEY = "intentId"

#: `local_reason` on a `record_intention` capture kept off Index on purpose
#: (ambient-intents spec §4: "the resident asked, or the content is personal").
LOCAL_REASONS = frozenset({"participant_asked", "personal"})

#: `publish_refused`: a code, never text. Anything else is dropped to null.
_CODE_PATTERN = re.compile(r"^[a-z0-9_]{1,64}$")

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
        "publish_refused",
        "local_reason",
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
        publish_refused: Optional[str] = None,
        local_reason: Optional[str] = None,
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
        self.publish_refused = publish_refused
        self.local_reason = local_reason


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
    attempts = 0
    for line in value.split("\n"):
        indent = len(line) - len(line.lstrip())
        if line[indent:indent + 1] == "{":
            # Each failed attempt can scan to the end of the text, so an
            # adversarial result (thousands of lines opening an object that
            # never closes) would be quadratic. Give up after a few.
            attempts += 1
            if attempts > MAX_JSON_ATTEMPTS:
                break
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


def result_intent_id(payload: Any) -> Optional[str]:
    """The intent id a write result names, or None.

    The intent object's own id (`result_intent`) first; else `intentId` at the
    top of the payload or under `data`, which is where Index's `create_intent`,
    `pause_intent`, `resume_intent` and `archive_intent` results put it
    (`mcp.tools.ts`). A bare `id` on `data` or at the top names nothing.
    """
    intent_id = _first_id(result_intent(payload))
    if intent_id is not None:
        return intent_id
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    return _args_id(payload, RESULT_INTENT_ID_KEY) or (
        _args_id(data, RESULT_INTENT_ID_KEY) if isinstance(data, dict) else None
    )


def _resolved_id(arg_id: str, result_id: Optional[str]) -> tuple[str, bool]:
    """(the id to record, whether the result describes the same intent).

    Index accepts a short id prefix for `intentId` and answers with the full
    id, so a result id that extends the argument is the same intent and is
    the one recorded. A result naming a different intent is ignored.
    """
    if result_id is None:
        return arg_id, True
    if result_id == arg_id or result_id.startswith(arg_id):
        return result_id, True
    return arg_id, False


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
    """Events for a successful Index intent write (`INDEX_INTENT_TOOLS`).

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
        intent_id = result_intent_id(payload)
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

    arg_id = _args_id(args, *_ARG_ID_KEYS)
    if arg_id is None:
        # A write to an intention we cannot name joins nothing.
        return []
    intent_id, same_intent = _resolved_id(arg_id, result_intent_id(payload))

    if tool in LIFECYCLE_STATUS:
        # Pause, resume, archive (and the legacy delete): the tool says what
        # the status is now. No text changes, so both hashes are null.
        return [
            IntentionCall(
                INDEX_INTENT_TOOLS[tool],
                intention_id=intent_id,
                index_intent_id=intent_id,
                source=source,
                capture_path="index_tool",
                index_status=LIFECYCLE_STATUS[tool],
            )
        ]

    # `update_intent`. Index's takes no status and refuses an archived intent;
    # a `status` argument or an archived result is read only for an older
    # Index surface, where either side saying the intent is gone is a withdrawal.
    arg_status = normalise_status(args.get("status"))
    result_status: Optional[str] = None
    if intent is not None and same_intent:
        result_status = "archived" if intent.get("archived") is True else normalise_status(intent.get("status"))
    if arg_status in WITHDRAWN_STATUSES:
        status: Optional[str] = arg_status
    elif result_status in WITHDRAWN_STATUSES:
        status = result_status
    else:
        status = arg_status or result_status

    if status in WITHDRAWN_STATUSES:
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
        # A status-only or source-fields-only update changes no text:
        # nothing new to version.
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


def _result_field_id(obj: Any, key: str) -> Optional[str]:
    """`key` as an id, at the top of a tool result or under its `data`."""
    if not isinstance(obj, dict):
        return None
    data = obj.get("data")
    return _args_id(obj, key) or (_args_id(data, key) if isinstance(data, dict) else None)


def _result_intention_id(obj: Any) -> Optional[str]:
    return _result_field_id(obj, "intention_id")


def _result_code(payload: Any, outer: Any, key: str) -> Optional[str]:
    """A short lowercase code the tool's result names under `key`, else None."""
    for obj in (payload, outer):
        value = _result_field_id(obj, key)
        if value is not None:
            return value if _CODE_PATTERN.fullmatch(value) else None
    return None


def _result_has(obj: Any, key: str) -> tuple[bool, Any]:
    """Whether a tool result names `key` at the top or under `data`, and its value (null included)."""
    if not isinstance(obj, dict):
        return False, None
    if key in obj:
        return True, obj[key]
    data = obj.get("data")
    if isinstance(data, dict) and key in data:
        return True, data[key]
    return False, None


def _result_index_intent_id(payload: Any, outer: Any, args: dict) -> Optional[str]:
    """F6: a result that names `index_intent_id` decides it, null included; the
    argument counts only when the result is silent on it."""
    for obj in (payload, outer):
        present, value = _result_has(obj, "index_intent_id")
        if present:
            if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value):
                return str(value)
            return None
    return _args_id(args, "index_intent_id")


def plan_record(
    args: dict, payload: Any, outer: Any = None, *, cron: bool = False, trust_result: bool = True
) -> list[IntentionCall]:
    """Events for a `record_intention` call. Contract: README "Intention capture".

    `action` ∈ `capture|update|archive|withdraw|delete`; any other action
    records nothing. With no `action`, a call naming an `intention_id` is an
    update and a call naming none records nothing. `capture` on an existing id
    is an update. `outer` is the result before unwrapping, for a native tool
    that returns `{"result": ..., "intention_id": ...}`.

    `trust_result` (F13) is true only for the unprefixed overlay tool: then the
    result's `action`, `source`, `index_intent_id` and codes are read. A
    `record_intention` served by some MCP server is read as DATA-27 read it
    (the result names only the captured `intention_id`).
    """
    if not trust_result:
        payload_r: Any = None
        outer_r: Any = None
    else:
        payload_r, outer_r = payload, outer
    arg_id = _args_id(args, "intention_id")
    raw_action = args.get("action")
    action = raw_action.strip().lower() if isinstance(raw_action, str) else ""
    if not action:
        # DATA-212: the overlay tool defaults `action` to `capture` and says in
        # its result which action it performed.
        action = _result_code(payload_r, outer_r, "action") or ""

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
    result_source = _result_code(payload_r, outer_r, "source")
    # An update or withdrawal names no source; the overlay tool returns the one
    # it stored at capture, and that is used when the call's own is missing.
    if source not in RECORD_SOURCES and result_source in RECORD_SOURCES:
        source = result_source
    if cron or source not in RECORD_SOURCES:
        source = RESTRICTIVE_SOURCE
    # The overlay tool says when it held an intention as ambient (a cron run it
    # detected itself): the more restrictive of the two wins, never the looser.
    if result_source == RESTRICTIVE_SOURCE:
        source = RESTRICTIVE_SOURCE

    # DATA-212: the Index id the tool published under, else the argument (a
    # caller that already knew it). Codes are read only from the result: the
    # tool decided them, the model did not.
    index_intent_id = _result_index_intent_id(payload_r, outer_r, args)
    publish_refused = _result_code(payload_r, outer_r, "publish_refused")
    local_reason = _result_code(payload_r, outer_r, "local_reason")
    if local_reason not in LOCAL_REASONS:
        local_reason = None

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
            index_intent_id=index_intent_id,
            text=text,
            summary=summary,
            source=source,
            conditional=_conditional(args.get("conditional")),
            capture_path="record_intention",
            publish_refused=publish_refused,
            local_reason=local_reason,
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
    server, tool = split_tool_name(tool_name)
    if kind == "record":
        return plan_record(safe_args, payload, _first_json(result), cron=cron, trust_result=server is None)
    return plan_index(tool, safe_args, payload, cron=cron)


__all__ = [
    "ID_PATTERN",
    "INDEX_INTENT_TOOLS",
    "INDEX_STATUSES",
    "LIFECYCLE_STATUS",
    "LOCAL_REASONS",
    "RECORD_INTENTION_TOOL",
    "RECORD_SOURCES",
    "WITHDRAWN_STATUSES",
    "IntentionCall",
    "classify_tool",
    "normalise_status",
    "plan",
    "result_intent",
    "result_intent_id",
    "split_tool_name",
    "unwrap_result",
    "valid_id",
]
