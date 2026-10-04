"""DATA-249: every Index call the overlay builds, every Index intent tool the
observer watches, and every one the agent-facing text names, matches the
checked-in copy of Index's intent contract (`vectors/index_intent_contract.json`).

`record_intention` writes to Index over REST (`rest_writes`); the observer
still watches Index's MCP tool names (`tools`), which an agent may reach
through Hermes's own MCP client. When Index changes, change the vector first;
these tests then show what in the overlay must move with it. No test reaches
the network: the module's `_OPENER` is replaced by a recorder.
"""

from __future__ import annotations

import io
import json
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[3]
PLUGIN = Path(__file__).resolve().parents[1]
VECTOR = json.loads((Path(__file__).parent / "vectors" / "index_intent_contract.json").read_text(encoding="utf-8"))
CONTRACT: dict[str, dict] = VECTOR["tools"]
REST: dict[str, dict] = VECTOR["rest_writes"]
READS = {"list_intents", "get_intent"}
WRITES = set(CONTRACT) - READS
#: The observer's one legacy alias (not an Index tool; see `_intentions.py`).
LEGACY = {"delete_intent"}
#: DATA-272: Index's Hermes plugin, whose tools Hermes registers by bare name.
PLUGIN_TOOLS: list[str] = VECTOR["hermes_plugin"]["tools"]
PLUGIN_REQUESTS: dict[str, list] = VECTOR["hermes_plugin"]["requests"]
PLUGIN_WRITES: dict[str, dict] = VECTOR["hermes_plugin"]["intent_writes"]
SESSION = "sess-contract"
TEXT = "  Looking for a climbing partner in Goa\non weekends  "
INDEX_ID = "9b2f0c1e-0000-4000-8000-00000000abcd"
HELD_ID = "01927f3e-1b2c-7d4e-8f00-1234567890ab"


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


def schema_violations(label: str, schema: dict, arguments: Any) -> list[str]:
    if not isinstance(arguments, dict):
        return [f"{label}: not an object"]
    props = schema["properties"]
    out = [f"{label}: unexpected key {key!r}" for key in arguments if key not in props]
    out += [f"{label}: missing {key!r}" for key in schema["required"] if key not in arguments]
    groups = schema.get("anyOf_required")
    if groups and not any(all(k in arguments for k in group) for group in groups):
        out.append(f"{label}: needs one of {groups}")
    out += [f"{label}: {key!r} has the wrong type or size" for key, value in arguments.items()
            if key in props and not _type_ok(value, props[key])]
    return out


def violations(name: str, arguments: Any) -> list[str]:
    """Why the MCP call `name(arguments)` would not pass Index's input schema, or []."""
    spec = CONTRACT.get(name)
    if spec is None:
        return [f"{name}: not an Index intent tool"]
    return schema_violations(name, spec["input"], arguments)


_ID = r"(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{4,32})"


def rest_match(method: str, path: str) -> str | None:
    """Which contract write a request is, by method and path template."""
    for name, spec in REST.items():
        pattern = "^" + re.escape(spec["path"]).replace(re.escape("{id}"), _ID) + "$"
        if spec["method"] == method and re.match(pattern, path):
            return name
    return None


def rest_violations(method: str, path: str, raw: bytes | None, headers: dict) -> list[str]:
    """Why an HTTP request would not be one of Index's intent writes as the contract states it, or []."""
    name = rest_match(method, path)
    if name is None:
        return [f"{method} {path}: not an Index intent write"]
    schema = REST[name]["body"]
    if schema is None:
        return [] if raw is None else [f"{name}: sends a body"]
    if raw is None:
        return [f"{name}: no body"]
    if headers.get("content-type") != "application/json":
        return [f"{name}: content-type is not application/json"]
    return schema_violations(name, schema, json.loads(raw.decode("utf-8")))


def test_the_vector_names_index_mains_intent_contract():
    assert set(CONTRACT) == {
        "list_intents", "get_intent", "create_intent", "update_intent", "pause_intent", "resume_intent", "archive_intent",
    }
    assert {(s["method"], s["path"]) for s in REST.values()} == {
        ("POST", "/api/intents"), ("PATCH", "/api/intents/{id}"), ("PATCH", "/api/intents/{id}/archive"),
    }
    assert VECTOR["intent_status_values"] == ["active", "paused"]
    # The checkers themselves: the shapes Index rejects are rejected here.
    assert violations("update_intent", {"id": "x", "status": "archived"})
    assert violations("archive_intent", {"intentId": "x"})
    assert violations("delete_intent", {"intentId": "x"})
    assert violations("archive_intent", {"intentId": "x", "confirm": True}) == []
    j = {"content-type": "application/json"}
    assert rest_violations("POST", "/api/intents", b'{"description":"x","status":"active"}', j)
    assert rest_violations("POST", "/api/intents", b'{"sourceType":"agentvillage"}', j)
    assert rest_violations("PATCH", f"/api/intents/{INDEX_ID}", b"{}", j)
    assert rest_violations("PATCH", f"/api/intents/{INDEX_ID}/archive", b"{}", j)
    assert rest_violations("PATCH", "/api/intents/not%20an%20id", b'{"description":"x"}', j)
    assert rest_violations("DELETE", f"/api/intents/{INDEX_ID}", None, {})
    assert rest_violations("PATCH", f"/api/intents/{INDEX_ID}/archive", None, {}) == []


# --------------------------------------------------------------------------
# Every HTTP call the overlay builds to Index
# --------------------------------------------------------------------------


class _Answer:
    def __init__(self, body: dict) -> None:
        self.status = 200
        self.headers = {"content-type": "application/json"}
        self._body = io.BytesIO(json.dumps(body).encode())

    def read(self, n: int = -1) -> bytes:
        return self._body.read(n)

    def __enter__(self) -> "_Answer":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def success_body(name: str, sent: dict | None) -> dict:
    """A 2xx body for a contract write, with exactly its `success_keys`."""
    values = {"intentId": INDEX_ID, "networkIds": [], "success": True, "description": "x",
              "sourceType": (sent or {}).get("sourceType"), "sourceId": (sent or {}).get("sourceId")}
    return {key: values[key] for key in REST[name]["success_keys"]}


class Recorder:
    """Records every request the module sends and answers as Index main does:
    a 2xx body with the write's `success_keys`, or `fail_status` when set."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.fail_status: int | None = None

    def open(self, request, timeout=None):  # noqa: ANN001
        parts = urllib.parse.urlsplit(request.full_url)
        self.requests.append({
            "method": request.get_method(),
            "origin": f"{parts.scheme}://{parts.netloc}",
            "path": parts.path,
            "query": parts.query,
            "raw": request.data,
            "headers": {k.lower(): v for k, v in request.header_items()},
        })
        if self.fail_status is not None:
            raise urllib.error.HTTPError(request.full_url, self.fail_status, "x", {}, io.BytesIO(b'{"error":"x"}'))
        name = rest_match(request.get_method(), parts.path)
        assert name is not None, (request.get_method(), parts.path)
        sent = json.loads(request.data.decode()) if request.data is not None else None
        return _Answer(success_body(name, sent))


@pytest.fixture()
def ri(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._record_intention"]


@pytest.fixture()
def recorder(ri, monkeypatch, home):
    recorder = Recorder()
    monkeypatch.setattr(ri, "_OPENER", recorder)
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("INDEX_API_KEY", "contract-test-key-0123456789")
    ri.note_platform(SESSION, "telegram")
    return recorder


@pytest.fixture()
def recorded(recorder):
    return recorder.requests


#: The overlay call that reaches each contract write.
_CALLS = {
    "create": lambda ri: ri.publish_intent(TEXT)[1],
    "update": lambda ri: ri.mirror_update(INDEX_ID, description=TEXT),
    "archive": lambda ri: ri.mirror_update(INDEX_ID, archive=True),
}


@pytest.mark.parametrize("name,status", [(n, s) for n, spec in REST.items() for s in spec["error_statuses"]])
def test_every_documented_error_status_yields_its_code(ri, recorder, name, status):
    """F: each status a route can answer maps to a code, never an exception: 422 is
    `rejected`, a 5xx but 503 the ambiguous `timeout`, anything else `http_<n>`."""
    recorder.fail_status = status
    code = _CALLS[name](ri)
    expected = "rejected" if status == 422 else ("timeout" if status >= 500 and status != 503 else f"http_{status}")
    assert code == expected
    assert [rest_match(r["method"], r["path"]) for r in recorder.requests] == [name]


@pytest.mark.parametrize("name", list(REST))
def test_a_success_body_with_exactly_the_documented_keys_is_success(ri, recorder, name):
    """F: the Recorder answers with only the write's `success_keys`; that is enough."""
    assert _CALLS[name](ri) is None
    if name == "create":
        assert ri.publish_intent(TEXT) == (INDEX_ID, None)


def _drive_every_path(ri) -> None:
    """Every overlay path that calls Index, through its public entry points."""
    assert ri.publish_intent(TEXT) == (INDEX_ID, None)
    assert ri.publish_intent(TEXT, source_id=HELD_ID) == (INDEX_ID, None)
    assert ri.mirror_update(INDEX_ID, description=TEXT) is None
    assert ri.mirror_update(INDEX_ID, archive=True) is None
    out = ri.record_intention_answer({"text": TEXT, "source": "message"}, SESSION)
    assert out["published"] is True, out
    up = ri.record_intention_answer({"action": "update", "intention_id": out["intention_id"], "text": TEXT + "!"}, SESSION)
    assert "publish_refused" not in up, up
    gone = ri.record_intention_answer({"action": "withdraw", "intention_id": out["intention_id"]}, SESSION)
    assert "publish_refused" not in gone, gone


def test_every_http_call_the_overlay_builds_matches_the_contract(ri, recorded):
    """AC #2 and #3: method, path and body keys (and types) from Index's REST schema."""
    _drive_every_path(ri)
    assert recorded, "no Index call was made"
    problems = [p for r in recorded for p in rest_violations(r["method"], r["path"], r["raw"], r["headers"])]
    assert problems == []
    assert {rest_match(r["method"], r["path"]) for r in recorded} == set(REST)
    assert {r["origin"] for r in recorded} == {"https://protocol.index.network"}
    assert all(r["query"] == "" for r in recorded)
    # No `status` anywhere, no legacy `id`, no MCP envelope.
    bodies = [json.loads(r["raw"]) for r in recorded if r["raw"] is not None]
    assert all(not ({"status", "id", "jsonrpc", "method", "params"} & set(b)) for b in bodies)


def test_every_index_route_the_module_names_is_in_the_contract(ri):
    """The module's path constants are the contract's, so a new write must be added to both."""
    assert {ri.CREATE_PATH, ri.UPDATE_PATH, ri.ARCHIVE_PATH} == {s["path"] for s in REST.values()}
    source = (PLUGIN / "_record_intention.py").read_text(encoding="utf-8")
    assert "tools/call" not in source and '"jsonrpc"' not in source


def test_publish_always_marks_the_source_type_and_sends_a_source_id_only_when_given(ri, recorded):
    """DATA-249 O4: every create carries sourceType; sourceId only for a held
    intention published later (the other lane passes its uuid v7)."""
    ri.publish_intent(TEXT)
    ri.publish_intent(TEXT, source_id=HELD_ID)
    bodies = [json.loads(r["raw"]) for r in recorded]
    assert bodies == [
        {"description": TEXT, "sourceType": "agentvillage"},
        {"description": TEXT, "sourceType": "agentvillage", "sourceId": HELD_ID},
    ]
    assert [rest_violations(r["method"], r["path"], r["raw"], r["headers"]) for r in recorded] == [[], []]


def test_a_stated_capture_sends_source_type_and_no_source_id(ri, recorded):
    out = ri.record_intention_answer({"text": TEXT, "source": "message"}, SESSION)
    assert out["published"] is True and out["intention_id"] == INDEX_ID
    [request] = recorded
    assert (request["method"], request["path"]) == ("POST", "/api/intents")
    assert json.loads(request["raw"]) == {"description": TEXT, "sourceType": "agentvillage"}


@pytest.mark.parametrize("bad", ["int-7f3a", "../archive", "a/b", "", "9b2f0c1e 0000", "x" * 40, "0192f0aa%2F"])
def test_an_id_that_is_not_indexs_never_reaches_a_path(ri, recorded, bad):
    assert ri.mirror_update(bad, description=TEXT) == "id_invalid"
    assert ri.mirror_update(bad, archive=True) == "id_invalid"
    assert recorded == []


def test_a_short_hex_id_is_sent_in_the_path(ri, recorded):
    assert ri.mirror_update("9b2f0c1e", archive=True) is None
    assert [r["path"] for r in recorded] == ["/api/intents/9b2f0c1e/archive"]


# --------------------------------------------------------------------------
# The observer's tool names (Index's MCP surface)
# --------------------------------------------------------------------------


def test_the_observer_watches_every_index_write_and_nothing_else(plugin, av):
    intentions = sys.modules[f"{av.MODULE_NAME}._intentions"]
    watched = set(intentions.INDEX_INTENT_TOOLS)
    assert watched - LEGACY - set(PLUGIN_WRITES) == WRITES
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
# The observer's tool names (Index's Hermes plugin, DATA-272)
# --------------------------------------------------------------------------


def test_the_seed_lists_the_plugins_tools(plugin, av):
    """tool_categories_v3's `index_*` names are the plugin's tools, but the one it leaves out."""
    seed = json.loads((PLUGIN / "tool_categories.json").read_text(encoding="utf-8"))
    assert seed["version"] == "tool_categories_v3"
    seeded = {name for name in seed["builtin"] if name.startswith("index_")}
    assert len(PLUGIN_TOOLS) == len(set(PLUGIN_TOOLS)) == 16
    assert set(PLUGIN_TOOLS) == seeded | {"index_open_app"}
    assert all(seed["builtin"][name] == "intention" for name in PLUGIN_WRITES)


#: Non-GET calls of the plugin reviewed as NOT writing an intent's text or
#: status. Anything else that is not a GET must be decided here or watched.
REVIEWED_NON_WRITES = {
    ("POST", "/intents/list"): "a read of the caller's intents, sent as POST",
    ("POST", "/intents/{id}/networks"): "shares an intent into a community; text and status unchanged",
    ("POST", "/networks"): "creates a community",
    ("POST", "/network-requests"): "asks for early access to create a community",
    ("PUT", "/networks/{id}"): "renames or redescribes a community",
    ("POST", "/networks/{id}/join"): "joins a community",
    ("PATCH", "/opportunities/{id}/status"): "accepts or rejects an opportunity",
    ("POST", "/enrichment/enrich"): "researches the owner's profile, persists nothing",
}


def _writes_an_intent(method: str, path: str) -> bool:
    """Whether a plugin REST call creates an intent or changes its text or status.

    A GET never does. A reviewed non-write (`REVIEWED_NON_WRITES`) does not.
    Any other call with a path segment `intents` does. Any other non-GET call
    is undecided, and fails the test until someone decides it.
    """
    if method == "GET":
        return False
    if (method, path) in REVIEWED_NON_WRITES:
        return False
    if "intents" in path.strip("/").split("/"):
        return True
    pytest.fail(
        f"Index plugin call {method} {path} is not reviewed: decide whether it writes an intent, then add "
        "it to REVIEWED_NON_WRITES (with the reason) or watch the tool that makes it (INDEX_PLUGIN_TOOLS)"
    )


def test_the_plugins_intent_writers_are_exactly_the_watched_set(plugin, av):
    """A writer added upstream (an archive, a pause, an intent write under another
    resource) fails here once the vector is refreshed, and so does any new
    non-GET call nobody has reviewed."""
    intentions = sys.modules[f"{av.MODULE_NAME}._intentions"]
    assert set(PLUGIN_REQUESTS) == set(PLUGIN_TOOLS)
    writers = {tool for tool, calls in PLUGIN_REQUESTS.items()
               if any(_writes_an_intent(method, path) for method, path in calls)}
    assert writers == set(PLUGIN_WRITES) == set(intentions.INDEX_PLUGIN_TOOLS)
    # Of the plugin's 16 tools, exactly the writers are watched.
    watched = {name for name in PLUGIN_TOOLS if intentions.classify_tool(name) is not None}
    assert watched == writers
    # Every reviewed non-write is still one the plugin makes (no stale reviews).
    made = {(method, path) for calls in PLUGIN_REQUESTS.values() for method, path in calls}
    assert set(REVIEWED_NON_WRITES) <= made


def test_each_plugin_writer_is_observed_as_its_mcp_twin_and_reads_only_its_own_arguments(plugin, av):
    intentions = sys.modules[f"{av.MODULE_NAME}._intentions"]
    for bare, spec in PLUGIN_WRITES.items():
        assert intentions.INDEX_PLUGIN_TOOLS[bare] == spec["observed_as"]
        assert spec["observed_as"] in WRITES
        assert intentions.INDEX_INTENT_TOOLS[bare] == intentions.INDEX_INTENT_TOOLS[spec["observed_as"]]
        read = intentions.INDEX_PLUGIN_ARGS[bare]
        schema = spec["input"]
        # Every key read is a required string of the plugin's schema, and every
        # required key is read (the plugin refuses a call missing one).
        assert set(read) == set(schema["required"]), bare
        assert all(schema["properties"][key]["type"] == "string" for key in read), bare
        # The observed MCP tool takes the same keys, so its events mean the same.
        mcp_props = CONTRACT[spec["observed_as"]]["input"]["properties"]
        assert set(read) <= set(mcp_props), bare


# --------------------------------------------------------------------------
# What the overlay tells the agent
# --------------------------------------------------------------------------

#: Agent-facing text: skills, prompts, the workspace AGENTS.md, the tool description.
AGENT_TEXT = sorted(
    [p for p in (REPO / "skills").rglob("*.md")] + [REPO / "workspace" / "AGENTS.md", REPO / "workspace" / "SOUL.md"]
)
_INTENT_TOOL = re.compile(r"\b((?:[a-z]+_)+intents?)\b")
_CALL = re.compile(r"\b((?:[a-z]+_)+intents?)\(([^)]*)\)")
_KWARG = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*=")


def test_agent_text_names_only_index_intent_tools(ri):
    texts = [(p, p.read_text(encoding="utf-8")) for p in AGENT_TEXT]
    texts.append((PLUGIN / "_record_intention.py:TOOL_DESCRIPTION", ri.TOOL_DESCRIPTION))
    unknown = sorted({
        f"{path.relative_to(REPO) if path.is_absolute() and REPO in path.parents else path}: {name}"
        for path, text in texts for name in _INTENT_TOOL.findall(text)
        if name not in CONTRACT and name not in PLUGIN_TOOLS
    })
    assert unknown == []
    # The plugin's input schemas are not in the vector, so no text shows a call to one.
    plugin_calls = sorted({f"{path.name}: {name}({args})" for path, text in texts
                           for name, args in _CALL.findall(text) if name in PLUGIN_TOOLS})
    assert plugin_calls == []
    bad_args = sorted({
        f"{path.name}: {name}({args}) passes {key!r}"
        for path, text in texts for name, args in _CALL.findall(text)
        for key in _KWARG.findall(args)
        if name in CONTRACT and key not in CONTRACT[name]["input"]["properties"]
    })
    assert bad_args == []
    # F: Index's schema requires the literal `confirm: true` on every archive.
    archives = [(path.name, args) for path, text in texts for name, args in _CALL.findall(text) if name == "archive_intent"]
    assert archives, "no documented archive_intent call to check"
    unconfirmed = [f"{name}: archive_intent({args})" for name, args in archives
                   if not re.search(r"\bconfirm\s*=\s*true\b", args, re.IGNORECASE)]
    assert unconfirmed == []


#: DATA-272 ruling: for a new want, `record_intention` only; an intention it
#: did not record may be changed with Index's own update tools, and only to
#: reword the same want (a different want is a new one).
PROHIBIT = "never call Index create_intent or index_create_intent for a new want"
PERMIT = "may be changed with Index's own update_intent or index_update_intent, only to reword the same want"
DIFFERENT = "a different want is a new want and goes through"
_DENY = re.compile(r"\b(never|do not|don't|must not|not allowed)\b", re.IGNORECASE)
_ALLOW = re.compile(r"\b(may|can|you are free|allowed to)\b", re.IGNORECASE)
#: Clauses about the path when `record_intention` is NOT available, where
#: calling Index's own tools is the instruction.
_UNAVAILABLE = re.compile(r"\b(otherwise|not available|does not find it|ignore this file)\b", re.IGNORECASE)
#: Index's intent create and update tools, MCP and bare names.
CREATES = ("create_intent", "index_create_intent")
UPDATES = ("update_intent", "index_update_intent")


def _names(name: str) -> re.Pattern:
    return re.compile(rf"(?<![a-z_]){name}(?![a-z_])")


def _front_door_texts(ri) -> dict[str, str]:
    texts = {
        "TOOL_DESCRIPTION": ri.TOOL_DESCRIPTION,
        "SKILL.md": (REPO / "skills" / "record-intention" / "SKILL.md").read_text(encoding="utf-8"),
        "SOUL.md": (REPO / "workspace" / "SOUL.md").read_text(encoding="utf-8"),
        "AGENTS.md": (REPO / "workspace" / "AGENTS.md").read_text(encoding="utf-8"),
    }
    # Backticks off and whitespace folded, so a wrapped Markdown line reads as one.
    return {label: re.sub(r"\s+", " ", text.replace("`", "")) for label, text in texts.items()}


def _clauses(text: str) -> list[str]:
    return [c for c in re.split(r"(?<=[.;])\s+", text) if c]


def test_the_front_door_text_forbids_a_direct_create_and_permits_an_update_it_cannot_make(ri):
    """DATA-272 AC #2, narrowed by Carter's rulings: a new want goes through
    `record_intention`, never Index's `create_intent` / `index_create_intent`;
    an intention `record_intention` did not record may be changed with
    `update_intent` / `index_update_intent`, only to reword the same want, and a
    different want is a new want. Each said in each text, and no clause says
    the opposite about any of the four names."""
    problems = []
    for label, text in _front_door_texts(ri).items():
        own = "this tool" if label == "TOOL_DESCRIPTION" else "record_intention"
        if PROHIBIT not in text:
            problems.append(f"{label}: no prohibition of a direct create")
        if PERMIT not in text:
            problems.append(f"{label}: no same-want permission for an update record_intention cannot make")
        if f"{DIFFERENT} {own}" not in text.lower():
            problems.append(f"{label}: does not send a different want through {own}")
        if label != "TOOL_DESCRIPTION" and not _names("record_intention").search(text):
            problems.append(f"{label}: does not name record_intention")
        for clause in _clauses(text):
            if _UNAVAILABLE.search(clause):
                continue
            if any(_names(n).search(clause) for n in CREATES):
                if not _DENY.search(clause) or _ALLOW.search(clause):
                    problems.append(f"{label}: a create tool outside a prohibition: {clause!r}")
            if any(_names(n).search(clause) for n in UPDATES):
                if _DENY.search(clause) or not _ALLOW.search(clause):
                    problems.append(f"{label}: an update tool outside a permission: {clause!r}")
                if "same want" not in clause or re.search(r"\bdifferent\b|\bnew want\b|\bany want\b", clause, re.IGNORECASE):
                    problems.append(f"{label}: an update permission not limited to the same want: {clause!r}")
            if re.search(r"\bdifferent want\b", clause, re.IGNORECASE):
                if "is a new want" not in clause or own not in clause or any(_names(n).search(clause) for n in UPDATES):
                    problems.append(f"{label}: a different want not sent through {own}: {clause!r}")
    assert problems == []


def test_the_front_door_text_stays_conditional_on_record_intention(ri):
    """In SOUL.md and AGENTS.md, Index's create and update tools (MCP and bare
    names) are spoken of only on the line that opens "if record_intention is
    available", after that opening; the skill and the tool description exist
    only when it is."""
    gate = re.compile(r"if record_intention is available", re.IGNORECASE)
    for label in ("SOUL.md", "AGENTS.md"):
        lines = (REPO / "workspace" / label).read_text(encoding="utf-8").replace("`", "").splitlines()
        assert sum(bool(gate.search(line)) for line in lines) == 1, label
        for number, line in enumerate(lines, 1):
            for name in (*CREATES, *UPDATES):
                for hit in _names(name).finditer(line):
                    opened = gate.search(line)
                    assert opened and hit.start() > opened.start(), f"{label}:{number}: {name} outside the gate"
