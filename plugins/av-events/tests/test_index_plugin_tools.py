"""DATA-272: Index's Hermes plugin intent writes, observed like the MCP tools.

Index ships a Hermes plugin whose tools Hermes registers by bare name
(`index_create_intent`, `index_update_intent`, and fourteen more; the list,
their REST calls and the two writers' schemas are `hermes_plugin` in
`vectors/index_intent_contract.json`, copied from the plugin's source). The two
intent writes produce the events of Index's MCP `create_intent` /
`update_intent`, but are read the way the plugin reads them: only
`description` (and `intentId` for the update), stripped as the plugin strips
them, and the plugin's own result object, where a failure is a field, not a
status. Nothing here routes or refuses a call (that half of DATA-272 is a later
change): `pre_tool_call` is still a counter.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Callable

import pytest

SESSION = "sess-plug"
TASK = "task-plug"
DESCRIPTION = "Looking for a cofounder who has shipped hardware"
SUMMARY = "Seeking hardware cofounder"
FULL_ID = "9b2f0c1e-0000-4000-8000-00000000abcd"
#: A string that must never leave in any form: not as text, not as a hash.
SECRET = "Alice Example of 12 Example Road, call her on her own number"

VECTOR = json.loads((Path(__file__).parent / "vectors" / "index_intent_contract.json").read_text(encoding="utf-8"))
PLUGIN_TOOLS: list[str] = VECTOR["hermes_plugin"]["tools"]
PLUGIN_WRITES: dict[str, str] = {
    bare: spec["observed_as"] for bare, spec in VECTOR["hermes_plugin"]["intent_writes"].items()
}
BARE_CREATE, BARE_UPDATE = "index_create_intent", "index_update_intent"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def wrapped(data: Any, *, success: bool = True) -> str:
    """An MCP result as Hermes hands it to `post_tool_call`."""
    return json.dumps({"result": json.dumps({"success": success, "data": data})})


def plain(data: Any) -> str:
    """A plugin tool's own return string: no Hermes MCP wrapper."""
    return json.dumps(data)


def plugin_answer(body: dict) -> str:
    """What Index's plugin returns for a 2xx: the REST body, compact, with an
    `appUrl` deep link added next to an `intentId` (`_api_result`)."""
    body = dict(body)
    if isinstance(body.get("intentId"), str):
        body.setdefault("appUrl", f"https://index.network/i/{body['intentId']}")
    return json.dumps(body, separators=(",", ":"))


def plugin_error(message: str, **extra: Any) -> str:
    """Index's plugin `_error`: a refusal or transport failure, as an object."""
    return json.dumps({"success": False, "error": message, **extra}, separators=(",", ":"))


class ToolFireCtx:
    """A `PluginContext` that takes hooks and tools (as in test_record_intention)."""

    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.tools: dict[str, dict] = {}

    def register_hook(self, hook_name, callback):  # noqa: ANN001
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def subscribe(self, event, callback):  # noqa: ANN001
        return None

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                      is_async=False, description="", emoji="", override=False):  # noqa: ANN001
        self.tools[name] = {"schema": schema, "handler": handler}
        return object()

    def fire(self, hook_name: str, **kwargs: Any) -> list:
        out = []
        for callback in self.hooks.get(hook_name, []):
            value = callback(**kwargs)
            if value is not None:
                out.append(value)
        return out


def fire_tool(ctx, tool_name, args, result, *, status="ok", session=SESSION, tool_call_id="call-1"):
    ctx.fire(
        "post_tool_call",
        tool_name=tool_name,
        args=args,
        result=result,
        session_id=session,
        task_id=TASK,
        turn_id="turn-1",
        tool_call_id=tool_call_id,
        api_request_id="req-1",
        duration_ms=500,
        status=status,
        error_type=None,
        error_message=None,
    )


def intention_events(av, plugin) -> list[dict]:
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("intention.")]


@pytest.fixture()
def intentions(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._intentions"]


@pytest.fixture()
def live(plugin, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return ctx


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name", [BARE_CREATE, BARE_UPDATE])
def test_each_bare_write_is_an_index_intent_tool(intentions, name):
    """AC #1: in INDEX_INTENT_TOOLS, and classify_tool says Index."""
    assert name in intentions.INDEX_INTENT_TOOLS
    assert intentions.classify_tool(name) == "index"


@pytest.mark.parametrize("name,event", [(BARE_CREATE, "intention.captured"), (BARE_UPDATE, "intention.updated")])
def test_each_bare_write_maps_to_its_mcp_tool(intentions, name, event):
    assert intentions.INDEX_INTENT_TOOLS[name] == event
    assert intentions.INDEX_PLUGIN_TOOLS[name] == PLUGIN_WRITES[name]


@pytest.mark.parametrize("server", ["index", "notindex", "someserver"])
@pytest.mark.parametrize("name", [BARE_CREATE, BARE_UPDATE])
def test_the_plugin_names_behind_an_mcp_server_are_not_the_plugin(intentions, server, name):
    assert intentions.classify_tool(f"mcp__{server}__{name}") is None


@pytest.mark.parametrize("name", sorted(set(PLUGIN_TOOLS) - set(PLUGIN_WRITES)))
def test_the_plugins_other_tools_record_no_intention(intentions, name):
    assert intentions.classify_tool(name) is None
    assert intentions.plan(name, {"description": DESCRIPTION, "intentId": FULL_ID},
                           plain({"intentId": FULL_ID}), "ok") == []


@pytest.mark.parametrize("name", [
    "index_delete_intent", "index_archive_intent", "index_pause_intent", "index_resume_intent",
    "index_create_intents", "index_create_intent_v2", "Index_create_intent", "index_create_intent ",
    "xindex_create_intent", "index_", "index",
])
def test_unknown_index_names_are_unaffected(intentions, name):
    assert intentions.classify_tool(name) is None
    assert intentions.plan(name, {"description": DESCRIPTION, "intentId": FULL_ID},
                           plain({"intentId": FULL_ID}), "ok") == []


# --------------------------------------------------------------------------
# Parity: a clean bare call plans exactly what its MCP twin plans
# --------------------------------------------------------------------------

#: (bare tool, args, result, status) for calls the plugin would make as given:
#: only its own arguments, already clean, answered with its own result object.
PARITY_CASES = [
    # Creates: Index main's create body (with the plugin's deep link), an intent object.
    (BARE_CREATE, {"description": DESCRIPTION}, plugin_answer({"intentId": FULL_ID, "networkIds": [], "sourceType": None, "sourceId": None}), "ok"),
    (BARE_CREATE, {"description": DESCRIPTION}, plugin_answer({"status": 201, "intentId": FULL_ID, "networkIds": []}), "ok"),
    (BARE_CREATE, {"description": DESCRIPTION}, plain({"success": True, "data": {"intentId": FULL_ID}}), "ok"),
    (BARE_CREATE, {"description": DESCRIPTION}, plain({"intent": {"id": "int-abc", "summary": SUMMARY, "status": "active"}}), "ok"),
    # Creates that name no intent, or that Hermes reports failed: nothing.
    (BARE_CREATE, {"description": DESCRIPTION}, plain({"networkIds": []}), "ok"),
    (BARE_CREATE, {"description": DESCRIPTION}, plain({"id": FULL_ID}), "ok"),
    (BARE_CREATE, {"description": DESCRIPTION}, plugin_answer({"intentId": FULL_ID}), "error"),
    (BARE_CREATE, {"description": DESCRIPTION}, plugin_answer({"intentId": FULL_ID}), "blocked"),
    # Updates: the full id, a short prefix the result resolves, a result naming another intent.
    (BARE_UPDATE, {"intentId": FULL_ID, "description": DESCRIPTION}, plugin_answer({"intentId": FULL_ID, "description": DESCRIPTION}), "ok"),
    (BARE_UPDATE, {"intentId": FULL_ID[:8], "description": DESCRIPTION}, plugin_answer({"intentId": FULL_ID}), "ok"),
    (BARE_UPDATE, {"intentId": FULL_ID[:8], "description": DESCRIPTION}, plugin_answer({"intentId": "ffffffff-other"}), "ok"),
    (BARE_UPDATE, {"intentId": "int-abc", "description": DESCRIPTION}, plain({"intent": {"id": "int-abc", "summary": SUMMARY}}), "ok"),
    (BARE_UPDATE, {"intentId": FULL_ID, "description": DESCRIPTION}, plugin_answer({"intentId": FULL_ID}), "timeout"),
]


def _plan_view(calls) -> list[dict]:
    return [{slot: getattr(call, slot) for slot in call.__slots__} for call in calls]


@pytest.mark.parametrize("cron", [False, True])
@pytest.mark.parametrize("bare,args,result,status", PARITY_CASES)
def test_a_clean_bare_write_plans_what_its_mcp_twin_plans(intentions, bare, args, result, status, cron):
    twin = f"mcp__index__{PLUGIN_WRITES[bare]}"
    got = _plan_view(intentions.plan(bare, args, result, status, cron=cron))
    want = _plan_view(intentions.plan(twin, args, result, status, cron=cron))
    assert got == want


def test_the_parity_cases_cover_every_outcome(intentions):
    """So the parity test above cannot pass by comparing empty lists."""
    seen = set()
    for bare, args, result, status in PARITY_CASES:
        calls = intentions.plan(bare, args, result, status)
        seen.add((bare, tuple(c.event_type for c in calls)))
    assert seen == {
        (BARE_CREATE, ("intention.captured",)),
        (BARE_CREATE, ()),
        (BARE_UPDATE, ("intention.updated",)),
        (BARE_UPDATE, ()),
    }


# --------------------------------------------------------------------------
# Where the plugin differs from the MCP tool, the observer follows the plugin
# --------------------------------------------------------------------------


@pytest.mark.parametrize("extra", [
    {"status": "archived"}, {"status": "deleted"}, {"status": "withdrawn"}, {"status": "paused"},
    {"archived": True}, {"confirm": True},
])
def test_a_bare_update_never_withdraws_whatever_else_the_call_carries(intentions, extra):
    """The plugin PATCHes only the description and drops every other key: a
    `status` argument changes nothing on Index, so it changes nothing here."""
    args = {"intentId": FULL_ID, "description": DESCRIPTION, **extra}
    calls = intentions.plan(BARE_UPDATE, args, plugin_answer({"intentId": FULL_ID, "description": DESCRIPTION}), "ok")
    assert [(c.event_type, c.intention_id, c.text, c.index_status) for c in calls] == [
        ("intention.updated", FULL_ID, DESCRIPTION, None)]


@pytest.mark.parametrize("result", [
    plain({"intent": {"id": FULL_ID, "archived": True}}),
    plain({"intent": {"id": FULL_ID, "status": "archived"}}),
    plain({"data": {"intent": {"id": FULL_ID, "status": "deleted"}}}),
])
def test_a_bare_update_result_saying_archived_is_not_a_withdrawal(intentions, result):
    """Only a rewrite is possible through the plugin; a result that reads as an
    archive is not one this tool can produce, and yields no withdrawal."""
    calls = intentions.plan(BARE_UPDATE, {"intentId": FULL_ID, "description": DESCRIPTION}, result, "ok")
    assert "intention.withdrawn" not in [c.event_type for c in calls]


@pytest.mark.parametrize("args", [
    {"id": FULL_ID, "description": DESCRIPTION},
    {"intent_id": FULL_ID, "description": DESCRIPTION},
    {"intentId": FULL_ID},
    {"intentId": FULL_ID, "text": DESCRIPTION},
    {"intentId": 12345, "description": DESCRIPTION},
    {"intentId": FULL_ID, "description": 7},
])
def test_a_bare_update_the_plugin_would_refuse_records_nothing(intentions, args):
    """The plugin requires `intentId` and `description` (legacy `id` /
    `intent_id` are not read) and answers anything else with an error."""
    assert intentions.plan(BARE_UPDATE, args, plugin_answer({"intentId": FULL_ID}), "ok") == []


@pytest.mark.parametrize("args", [{}, {"description": ""}, {"description": "   \n"}, {"description": 12},
                                  {"text": DESCRIPTION}, {"intent": DESCRIPTION}])
def test_a_bare_create_the_plugin_would_refuse_records_nothing(intentions, args):
    assert intentions.plan(BARE_CREATE, args, plugin_answer({"intentId": FULL_ID}), "ok") == []


def test_a_bare_create_ignores_network_ids(intentions):
    with_ids = intentions.plan(BARE_CREATE, {"description": DESCRIPTION, "networkIds": ["n1", "n2"]},
                               plugin_answer({"intentId": FULL_ID, "networkIds": ["n1", "n2"]}), "ok")
    without = intentions.plan(BARE_CREATE, {"description": DESCRIPTION}, plugin_answer({"intentId": FULL_ID}), "ok")
    assert _plan_view(with_ids) == _plan_view(without)


# Whitespace: the plugin strips both strings (`_clean_string`) before Index sees them.


@pytest.mark.parametrize("padded", [" " + FULL_ID, FULL_ID + " ", "\t" + FULL_ID + "\n"])
def test_a_padded_intent_id_is_read_as_the_plugin_sends_it(intentions, padded):
    calls = intentions.plan(BARE_UPDATE, {"intentId": padded, "description": DESCRIPTION},
                            plugin_answer({"intentId": FULL_ID, "description": DESCRIPTION}), "ok")
    assert [(c.event_type, c.intention_id, c.index_intent_id) for c in calls] == [
        ("intention.updated", FULL_ID, FULL_ID)]


def test_a_padded_short_id_still_resolves_to_the_full_id(intentions):
    calls = intentions.plan(BARE_UPDATE, {"intentId": "  " + FULL_ID[:8] + " ", "description": DESCRIPTION},
                            plugin_answer({"intentId": FULL_ID}), "ok")
    assert [c.intention_id for c in calls] == [FULL_ID]


@pytest.mark.parametrize("bare,args", [
    (BARE_CREATE, {"description": "  " + DESCRIPTION + "\n"}),
    (BARE_UPDATE, {"intentId": FULL_ID, "description": "\t" + DESCRIPTION + "  "}),
])
def test_a_padded_description_hashes_as_index_stores_it(plugin, live, av, bare, args):
    fire_tool(live, bare, args, plugin_answer({"intentId": FULL_ID, "description": DESCRIPTION}))
    [event] = intention_events(av, plugin)
    assert event["payload"]["text_hash"] == sha(DESCRIPTION)


def test_inner_whitespace_is_kept(intentions):
    """`_clean_string` strips the ends only."""
    text = "Looking for  a cofounder\nwho has shipped hardware"
    [call] = intentions.plan(BARE_CREATE, {"description": " " + text + " "}, plugin_answer({"intentId": FULL_ID}), "ok")
    assert call.text == text


# Failures: the plugin answers non-2xx as an object, with Hermes's status `ok`.

FAILURE_SHAPES = [
    plugin_error("description is required."),
    plugin_error("Index request failed", status=422),
    plugin_error("intentId is required."),
    plugin_answer({"status": 422, "message": "Intent is too vague", "needsRevision": True}),
    plugin_answer({"status": 422, "message": "too vague", "intentId": FULL_ID}),
    plugin_answer({"status": 404, "message": "Intent not found", "intentId": FULL_ID}),
    plugin_answer({"status": 409, "message": "ambiguous id", "intentId": FULL_ID}),
    plugin_answer({"status": 401, "intentId": FULL_ID}),
    plugin_answer({"status": 500, "intentId": FULL_ID}),
    plugin_answer({"status": 503, "intentId": FULL_ID}),
    plugin_answer({"ok": False, "intentId": FULL_ID}),
    plugin_answer({"success": False, "intentId": FULL_ID}),
    plugin_answer({"error": None, "intentId": FULL_ID}),
    plugin_answer({"error": "Index transport response could not be processed", "intentId": FULL_ID}),
    plain([{"intentId": FULL_ID}]),
    "Created your signal " + FULL_ID,
    "",
    None,
]


@pytest.mark.parametrize("bare", [BARE_CREATE, BARE_UPDATE])
@pytest.mark.parametrize("result", FAILURE_SHAPES)
def test_a_failure_the_plugin_reports_in_its_result_records_nothing(intentions, bare, result):
    args = {"description": DESCRIPTION, "intentId": FULL_ID}
    assert intentions.plan(bare, args, result, "ok") == []


@pytest.mark.parametrize("result", [
    plugin_answer({"status": 200, "intentId": FULL_ID}),
    plugin_answer({"status": 201, "intentId": FULL_ID}),
    plugin_answer({"status": 399, "intentId": FULL_ID}),
    plugin_answer({"status": True, "intentId": FULL_ID}),
    plugin_answer({"status": "500", "intentId": FULL_ID}),
    plugin_answer({"ok": True, "intentId": FULL_ID}),
    plugin_answer({"success": True, "intentId": FULL_ID}),
])
def test_a_success_status_or_flag_still_records(intentions, result):
    """Only an integer of 400 or more is an HTTP failure; a boolean or a string `status` is not one."""
    [call] = intentions.plan(BARE_CREATE, {"description": DESCRIPTION}, result, "ok")
    assert call.intention_id == FULL_ID


def test_the_bare_path_never_unwraps_the_mcp_envelope(intentions):
    """Hermes wraps MCP results only; a plugin answer is its own object, so a
    `result` envelope is not read for an id."""
    assert intentions.plan(BARE_CREATE, {"description": DESCRIPTION}, wrapped({"intentId": FULL_ID}), "ok") == []
    # The MCP name does read it.
    assert len(intentions.plan("mcp__index__create_intent", {"description": DESCRIPTION},
                               wrapped({"intentId": FULL_ID}), "ok")) == 1


# --------------------------------------------------------------------------
# Through the hooks: the same events the MCP names produce
# --------------------------------------------------------------------------


def test_a_bare_create_emits_intention_captured(plugin, live, av):
    fire_tool(live, BARE_CREATE, {"description": DESCRIPTION},
              plain({"intentId": FULL_ID, "networkIds": [], "sourceType": None, "sourceId": None}))
    [event] = intention_events(av, plugin)
    assert event["event_type"] == "intention.captured"
    assert event["intention_id"] == FULL_ID
    payload = event["payload"]
    assert payload["index_intent_id"] == FULL_ID
    assert payload["text_hash"] == sha(DESCRIPTION)
    assert payload["capture_path"] == "index_tool"
    assert payload["source"] == "message"
    assert event["tool_call_id"] == "call-1"


def test_a_bare_update_emits_intention_updated_under_the_full_id(plugin, live, av):
    fire_tool(live, BARE_UPDATE, {"intentId": FULL_ID[:8], "description": DESCRIPTION + "!"},
              plain({"intentId": FULL_ID, "description": DESCRIPTION + "!"}))
    [event] = intention_events(av, plugin)
    assert event["event_type"] == "intention.updated"
    assert event["intention_id"] == FULL_ID
    assert event["payload"]["text_hash"] == sha(DESCRIPTION + "!")
    assert event["payload"]["capture_path"] == "index_tool"


def test_a_bare_create_in_a_cron_session_is_ambient(plugin, live, av):
    live.fire("on_session_start", session_id="sess-nightly", model="m", platform="cron")
    fire_tool(live, BARE_CREATE, {"description": DESCRIPTION}, plain({"intentId": FULL_ID}), session="sess-nightly")
    assert intention_events(av, plugin)[0]["payload"]["source"] == "ambient"


def _strip(event: dict) -> dict:
    """An event without what differs between two calls: ids, times, sequence, its tool call."""
    drop = {"event_id", "occurred_at", "occurred_at_earliest", "occurred_at_latest", "recorded_at",
            "tool_call_id", "seq", "sequence", "emitted_at"}
    return {k: v for k, v in event.items() if k not in drop}


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_bare_and_mcp_calls_emit_identical_intention_events(plugin, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    steps = [
        ("create_intent", {"description": DESCRIPTION}, plain({"intent": {"id": "int-abc", "summary": SUMMARY}})),
        ("update_intent", {"intentId": "int-abc", "description": DESCRIPTION + "!"}, plugin_answer({"intentId": "int-abc"})),
        ("update_intent", {"intentId": "int-abc", "description": DESCRIPTION + "!!"},
         plugin_answer({"intentId": "int-abc", "description": DESCRIPTION + "!!"})),
    ]
    for i, (tool, args, result) in enumerate(steps):
        fire_tool(ctx, f"mcp__index__{tool}", args, result, tool_call_id=f"m{i}")
    mcp = [_strip(e) for e in intention_events(av, plugin)]
    for i, (tool, args, result) in enumerate(steps):
        fire_tool(ctx, f"index_{tool}", args, result, tool_call_id=f"b{i}")
    both = [_strip(e) for e in intention_events(av, plugin)]
    assert [e["event_type"] for e in mcp] == ["intention.captured", "intention.updated", "intention.updated"]
    assert both[len(mcp):] == mcp


# --------------------------------------------------------------------------
# No new text: only `description` is read, and only as a hash
# --------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_no_argument_but_description_is_read_and_no_text_leaves(plugin, monkeypatch, av, mode):
    """Argument keys the MCP path does not read stay unread on the bare path too.

    The plugin's own schema is not in the vector, so a call may carry keys the
    MCP tool has not: none of them may reach an intention event, as text or as
    a hash, and the description itself leaves only as its hash.
    """
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    extra = {"text": SECRET, "intent": SECRET, "content": SECRET, "summary": SECRET, "prompt": SECRET,
             "status": "archived", "id": "int-legacy", "intent_id": "int-legacy2"}
    fire_tool(ctx, BARE_CREATE, {"description": DESCRIPTION, **extra}, plain({"intentId": FULL_ID}), tool_call_id="c1")
    # No `description` (the plugin refuses), so nothing; a `status` never withdraws.
    fire_tool(ctx, BARE_UPDATE, {"intentId": FULL_ID, **extra}, plain({"intentId": FULL_ID}), tool_call_id="c2")
    # Legacy id keys are not read: without `intentId` the plugin refuses.
    fire_tool(ctx, BARE_UPDATE, {"description": DESCRIPTION, **extra}, plain({"intentId": FULL_ID}), tool_call_id="c3")
    events = intention_events(av, plugin)
    assert [e["event_type"] for e in events] == ["intention.captured"]
    assert "int-legacy" not in json.dumps(events)
    payload = events[0]["payload"]
    assert payload["text_hash"] == sha(DESCRIPTION)
    assert payload["summary_hash"] is None
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    for leak in (SECRET, "Alice", "Example Road", sha(SECRET), DESCRIPTION):
        assert leak not in blob, (mode, leak)


# --------------------------------------------------------------------------
# AV_RECORD_INTENTION on and off
# --------------------------------------------------------------------------


@pytest.mark.parametrize("switch", ["0", "1"])
def test_bare_writes_are_observed_whether_record_intention_is_on_or_off(plugin, monkeypatch, av, switch):
    """The observer does not depend on the front door's switch: with the tool
    off the agent is told to call Index itself, and with it on a direct call
    is still a capture to count. Neither is refused or rewritten here (the
    routing rule is a later change): `pre_tool_call` returns nothing."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_RECORD_INTENTION", switch)
    monkeypatch.setenv("INDEX_API_KEY", "test-index-key")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    assert ("record_intention" in ctx.tools) is (switch == "1")
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    for name, args in ((BARE_CREATE, {"description": DESCRIPTION}),
                       (BARE_UPDATE, {"intentId": FULL_ID, "description": DESCRIPTION + "!"})):
        assert ctx.fire("pre_tool_call", tool_name=name, args=args, session_id=SESSION,
                        task_id=TASK, tool_call_id="pre") == []
    fire_tool(ctx, BARE_CREATE, {"description": DESCRIPTION}, plain({"intentId": FULL_ID}), tool_call_id="c1")
    fire_tool(ctx, BARE_UPDATE, {"intentId": FULL_ID, "description": DESCRIPTION + "!"},
              plain({"intentId": FULL_ID}), tool_call_id="c2")
    events = intention_events(av, plugin)
    assert [e["event_type"] for e in events] == ["intention.captured", "intention.updated"]
    assert {e["payload"]["capture_path"] for e in events} == {"index_tool"}
    assert {e["intention_id"] for e in events} == {FULL_ID}


# --------------------------------------------------------------------------
# tool.call: the seed already lists both names (tool_categories_v3)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name", [BARE_CREATE, BARE_UPDATE])
def test_tool_call_names_and_categorises_the_bare_writes(plugin, live, av, name):
    fire_tool(live, name, {"description": DESCRIPTION, "intentId": FULL_ID}, plain({"intentId": FULL_ID}))
    [event] = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "tool.call"]
    assert event["payload"]["tool_name"] == name
    assert event["payload"]["tool_category"] == "intention"
