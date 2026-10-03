"""DATA-249: every Index MCP call the overlay builds, and every Index intent tool
the observer or the agent-facing text names, matches the checked-in copy of
Index's MCP input schemas (`vectors/index_mcp_intent_tools.json`).

When Index changes a tool, change the vector first; these tests then show what
in the overlay must move with it. No test reaches the network: the module's
`index_tool_call` is replaced by a recorder.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[3]
PLUGIN = Path(__file__).resolve().parents[1]
VECTOR = json.loads((Path(__file__).parent / "vectors" / "index_mcp_intent_tools.json").read_text(encoding="utf-8"))
CONTRACT: dict[str, dict] = VECTOR["tools"]
READS = {"list_intents", "get_intent"}
WRITES = set(CONTRACT) - READS
#: The observer's one legacy alias (not an Index tool; see `_intentions.py`).
LEGACY = {"delete_intent"}
SESSION = "sess-contract"
TEXT = "  Looking for a climbing partner in Goa\non weekends  "


def _type_ok(value: Any, spec: dict) -> bool:
    if "const" in spec:
        return value is spec["const"] if isinstance(spec["const"], bool) else value == spec["const"]
    types = spec.get("type")
    types = [types] if isinstance(types, str) else list(types or [])
    checks = {
        "string": lambda v: isinstance(v, str),
        "null": lambda v: v is None,
        "boolean": lambda v: isinstance(v, bool),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "array": lambda v: isinstance(v, list),
    }
    if not any(checks[t](value) for t in types):
        return False
    if isinstance(value, str):
        if len(value) < spec.get("minLength", 0) or len(value) > spec.get("maxLength", 1 << 30):
            return False
    return True


def violations(name: str, arguments: Any) -> list[str]:
    """Why `name(arguments)` would not pass Index's input schema, or []."""
    spec = CONTRACT.get(name)
    if spec is None:
        return [f"{name}: not an Index intent tool"]
    if not isinstance(arguments, dict):
        return [f"{name}: arguments are not an object"]
    schema = spec["input"]
    props = schema["properties"]
    out = [f"{name}: unexpected argument {key!r}" for key in arguments if key not in props]
    out += [f"{name}: missing {key!r}" for key in schema["required"] if key not in arguments]
    groups = schema.get("anyOf_required")
    if groups and not any(all(k in arguments for k in group) for group in groups):
        out.append(f"{name}: needs one of {groups}")
    out += [f"{name}: {key!r} has the wrong type or size" for key, value in arguments.items()
            if key in props and not _type_ok(value, props[key])]
    return out


def test_the_vector_names_index_mains_seven_intent_tools():
    assert set(CONTRACT) == {
        "list_intents", "get_intent", "create_intent", "update_intent", "pause_intent", "resume_intent", "archive_intent",
    }
    assert VECTOR["intent_status_values"] == ["active", "paused"]
    # The checker itself: the shapes Index rejects are rejected here.
    assert violations("update_intent", {"id": "x", "status": "archived"})
    assert violations("update_intent", {"intentId": "x"})
    assert violations("archive_intent", {"intentId": "x"})
    assert violations("archive_intent", {"intentId": "x", "confirm": "true"})
    assert violations("delete_intent", {"intentId": "x"})
    assert violations("create_intent", {"description": "x", "sourceId": 7})
    assert violations("archive_intent", {"intentId": "x", "confirm": True}) == []


# --------------------------------------------------------------------------
# Every call the overlay builds
# --------------------------------------------------------------------------


@pytest.fixture()
def ri(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._record_intention"]


@pytest.fixture()
def recorded(ri, monkeypatch, home):
    """Replace the Index transport with a recorder that answers as Index main does."""
    calls: list[tuple[str, dict]] = []

    def fake(tool: str, arguments: dict, **_kw: Any):
        calls.append((tool, json.loads(json.dumps(arguments))))
        if tool == "create_intent":
            return {"intentId": "int-created", "url": "u", "networkIds": [],
                    "sourceType": arguments.get("sourceType"), "sourceId": arguments.get("sourceId")}, None
        if tool == "archive_intent":
            return {"intentId": arguments["intentId"], "url": "u", "archived": True, "message": "m"}, None
        return {"intent": {"id": arguments.get("intentId"), "status": "active"}}, None

    monkeypatch.setattr(ri, "index_tool_call", fake)
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("INDEX_API_KEY", "contract-test-key-0123456789")
    ri.note_platform(SESSION, "telegram")
    return calls


def _drive_every_path(ri) -> None:
    """Every overlay path that calls Index, through its public entry points."""
    ri.publish_intent(TEXT)
    ri.publish_intent(TEXT, source_id="01927f3e-1b2c-7d4e-8f00-1234567890ab")
    ri.mirror_update("int-x", description=TEXT)
    ri.mirror_update("int-x", archive=True)
    out = ri.record_intention_answer({"text": TEXT, "source": "message"}, SESSION)
    assert out["published"] is True, out
    ri.record_intention_answer({"action": "update", "intention_id": out["intention_id"], "text": TEXT + "!"}, SESSION)
    ri.record_intention_answer({"action": "withdraw", "intention_id": out["intention_id"]}, SESSION)


def test_every_mcp_call_the_overlay_builds_matches_the_contract(ri, recorded):
    """AC #2 and #3: tool names and argument names (and types) from Index's schema."""
    _drive_every_path(ri)
    assert recorded, "no Index call was made"
    problems = [p for name, args in recorded for p in violations(name, args)]
    assert problems == []
    assert {name for name, _ in recorded} == {"create_intent", "update_intent", "archive_intent"}
    # No `status` anywhere, no legacy `id`.
    assert all("status" not in args and "id" not in args for _, args in recorded)


def test_every_index_call_site_is_exercised_and_in_the_contract(ri, recorded):
    """A new `index_tool_call("<tool>", ...)` in the module must name a contract
    tool and be driven by the test above."""
    source = (PLUGIN / "_record_intention.py").read_text(encoding="utf-8")
    sites = set(re.findall(r'index_tool_call\(\s*"([a-z_]+)"', source))
    assert sites and sites <= set(CONTRACT)
    _drive_every_path(ri)
    assert sites == {name for name, _ in recorded}


def test_publish_carries_the_source_fields_only_with_a_source_id(ri, recorded):
    ri.publish_intent(TEXT)
    ri.publish_intent(TEXT, source_id="01927f3e-1b2c-7d4e-8f00-1234567890ab")
    assert recorded[0] == ("create_intent", {"description": TEXT})
    assert recorded[1] == ("create_intent", {
        "description": TEXT, "sourceType": "agentvillage", "sourceId": "01927f3e-1b2c-7d4e-8f00-1234567890ab",
    })


# --------------------------------------------------------------------------
# The observer's tool names
# --------------------------------------------------------------------------


def test_the_observer_watches_every_index_write_and_nothing_else(plugin, av):
    intentions = sys.modules[f"{av.MODULE_NAME}._intentions"]
    watched = set(intentions.INDEX_INTENT_TOOLS)
    assert watched - LEGACY == WRITES
    assert set(intentions.LIFECYCLE_STATUS) - LEGACY == {"pause_intent", "resume_intent", "archive_intent"}
    # The id argument the observer reads first is the one Index requires.
    assert intentions._ARG_ID_KEYS[0] == "intentId"
    for tool in WRITES - {"create_intent"}:
        assert "intentId" in CONTRACT[tool]["input"]["required"], tool
    # The result key it reads the id from is the one Index returns.
    for tool in ("create_intent", "pause_intent", "resume_intent", "archive_intent"):
        assert intentions.RESULT_INTENT_ID_KEY in CONTRACT[tool]["result_keys"], tool
    # Index's statuses are all listed.
    assert set(VECTOR["intent_status_values"]) <= intentions.INDEX_STATUSES


# --------------------------------------------------------------------------
# What the overlay tells the agent
# --------------------------------------------------------------------------

#: Agent-facing text: skills, prompts, the workspace AGENTS.md, the tool description.
AGENT_TEXT = sorted(
    [p for p in (REPO / "skills").rglob("*.md")] + [REPO / "workspace" / "AGENTS.md"]
)
_INTENT_TOOL = re.compile(r"\b((?:[a-z]+_)+intents?)\b")
_CALL = re.compile(r"\b((?:[a-z]+_)+intents?)\(([^)]*)\)")
_KWARG = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*=")


def test_agent_text_names_only_index_intent_tools(ri):
    texts = [(p, p.read_text(encoding="utf-8")) for p in AGENT_TEXT]
    texts.append((PLUGIN / "_record_intention.py:TOOL_DESCRIPTION", ri.TOOL_DESCRIPTION))
    unknown = sorted({
        f"{path.relative_to(REPO) if path.is_absolute() and REPO in path.parents else path}: {name}"
        for path, text in texts for name in _INTENT_TOOL.findall(text) if name not in CONTRACT
    })
    assert unknown == []
    bad_args = sorted({
        f"{path.name}: {name}({args}) passes {key!r}"
        for path, text in texts for name, args in _CALL.findall(text)
        for key in _KWARG.findall(args) if key not in CONTRACT[name]["input"]["properties"]
    })
    assert bad_args == []
