"""DATA-212 Lane B: `record_intention` through the resident's approval.md.

The daemon is faked in-process by `FakeServe`, which answers `approval
serve`'s `POST /verb/<name>` for `propose`, `wait --timeout 0`, `start` and
`withdraw` the way core does at approval.md PR #569 (answers checked against a
real `approval serve` on loopback: the exit codes, the `status` and `state`
words, `nothing-to-wait-for` after a spent grant, `not-granted` on a second
start of a manual key, `already-executed` on a second start of an autonomous
one, and `state: executed` when a started key is proposed again). It replaces
the module's transport, so every byte the plugin sends is recorded. Two tests
speak real HTTP (a loopback port and a unix socket) to exercise the
transport and the listener check. Index is faked as in
`test_record_intention.py`. No test reaches the network.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import socket
import stat
import sys
import threading
import time
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

SESSION = "sess-ap"
KEY = "index-key-for-intent-approval-tests-0123456789"
TOKEN = "agent-token-for-the-lane-b-tests-000001"
TEXT = "Looking for a climbing partner in Goa on weekends"
STATED = "Want to meet other founders working on climate"
INDEX_ID = "9b2f0c1e-0000-4000-8000-00000000abcd"
SECOND_ID = "9b2f0c1e-0000-4000-8000-0000000000b2"
FACADE = "https://approval.example"
ACTOR = "agent:test"
INFERRED = "intent.publish.inferred.index"
STATED_CLASS = "intent.publish.stated.index"


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------


class Response:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = io.BytesIO(body)

    def read(self, n: int = -1) -> bytes:
        return self._body.read(n)

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class FakeIndex:
    """Index's `POST /api/intents` (and the PATCH routes), in-process."""

    def __init__(self) -> None:
        self.answers: list[Any] = []
        self.default: Any = {"intentId": INDEX_ID, "networkIds": [], "sourceType": "agentvillage", "sourceId": None}
        self.requests: list[dict] = []

    def open(self, request, timeout=None):  # noqa: ANN001
        parts = urllib.parse.urlsplit(request.full_url)
        body = json.loads(request.data.decode()) if request.data is not None else None
        self.requests.append({"method": request.get_method(), "path": parts.path, "body": body, "raw": request.data})
        answer = self.answers.pop(0) if self.answers else self.default
        if isinstance(answer, BaseException):
            raise answer
        return Response(200, json.dumps(answer).encode())

    def creates(self) -> list[dict]:
        return [r for r in self.requests if r["method"] == "POST"]


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://protocol.index.network/api/intents", code, "x", {}, io.BytesIO(b"{}"))


def task_id(cls: str, key: str) -> str:
    raw = json.dumps([ACTOR, cls, key], separators=(",", ":")).encode()
    return "propose:" + hashlib.sha256(raw).hexdigest()[:32]


class FakeServe:
    """`approval serve`'s agent surface for the four verbs the plugin uses."""

    def __init__(self) -> None:
        self.autonomy = {INFERRED: "manual", STATED_CLASS: "autonomous"}
        self.requestable = {INFERRED, STATED_CLASS}
        self.tasks: dict[str, dict] = {}
        self.calls: list[dict] = []
        self.down = False
        self.headers: list[dict] = []
        self.policy = 1
        #: Test hooks: `on_wait(n)` runs before the n-th wait is answered (1-based)
        #: and may return an answer tuple to send instead; `start_answer` replaces
        #: start's answer; `hash_lie` makes propose name another payload hash.
        self.on_wait: Optional[Callable[[int], Optional[tuple]]] = None
        self.start_answer: Optional[tuple] = None
        self.hash_lie = False
        self.waits = 0

    # -- the human's side --------------------------------------------------
    def _by_key(self, key: str) -> dict:
        return next(t for t in self.tasks.values() if t["key"] == key)

    def grant(self, key: str) -> None:
        t = self._by_key(key)
        assert t["state"] == "requested"
        t["state"] = "granted"

    def reject(self, key: str) -> None:
        self._by_key(key)["state"] = "rejected"

    def expire(self, key: str) -> None:
        self._by_key(key)["state"] = "expired"

    def reattest(self) -> None:
        """A re-attested policy voids every pending request and harness grant."""
        self.policy += 1
        for t in self.tasks.values():
            if t["state"] in ("requested", "granted") and not t["executed"]:
                t["state"] = "void"

    def proposals(self) -> list[dict]:
        return [c for c in self.calls if c["verb"] == "propose"]

    def verbs(self) -> list[str]:
        return [c["verb"] for c in self.calls]

    # -- the wire ----------------------------------------------------------
    def transport(self, endpoint, path, body, headers):  # noqa: ANN001
        self.headers.append(dict(headers))
        if self.down:
            raise ConnectionRefusedError()
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        verb = path.rsplit("/", 1)[-1]
        args = json.loads(body.decode("utf-8"))
        flags = args.get("flags", {})
        positionals = args.get("positionals", [])
        self.calls.append({"verb": verb, "flags": flags, "positionals": positionals, "raw": body})
        code, out, err = getattr(self, "_" + verb)(positionals, flags)
        answer = {"exit_code": code, "stdout": json.dumps(out) + "\n" if out else "",
                  "stderr": json.dumps(err) + "\n" if err else "", "stdout_truncated": False, "stderr_truncated": False}
        return 200, json.dumps(answer).encode()

    @staticmethod
    def _error(code: str, exit_code: int = 1) -> tuple:
        return exit_code, None, {"ok": False, "error": {"code": code, "message": "x"}}

    def _propose(self, _pos, flags):
        cls, key, payload = flags["--class"], flags["--key"], flags["--payload-json"]
        assert flags["--json"] is True and isinstance(flags["--summary"], str)
        if not key.startswith(cls + ":"):
            return self._error("key-class-mismatch", 2)
        if cls not in self.requestable:
            return self._error("class-not-agent-requestable")
        task = task_id(cls, key)
        phash = hashlib.sha256(json.dumps(json.loads(payload), sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        manual = self.autonomy.get(cls) == "manual"
        t = self.tasks.get(task)
        if t is not None and t["hash"] != phash:
            return self._error("payload-mismatch")
        base = {"ok": True, "task": task, "action_key": key, "class": cls,
                "payload_hash": ("0" * 64) if self.hash_lie else phash}
        if t is None:
            t = {"key": key, "class": cls, "hash": phash, "payload": payload, "executed": False,
                 "state": "requested" if manual else "none", "asks": 0}
            self.tasks[task] = t
            if manual:
                t["asks"] = 1
                return 0, {**base, "decision": "requested", "state": "requested", "seq": 3, "idempotent": False}, None
            return 0, {**base, "decision": "autonomous", "state": None, "seq": None, "idempotent": False}, None
        if t["executed"]:
            return 0, {**base, "decision": "requested" if manual else "autonomous", "state": "executed",
                       "seq": 5, "idempotent": True}, None
        if t["state"] in ("expired", "void", "withdrawn"):
            t["state"] = "requested" if manual else "none"
            t["asks"] += 1
            return 0, {**base, "decision": "requested" if manual else "autonomous",
                       "state": "requested" if manual else None, "seq": 9, "idempotent": False}, None
        if t["state"] == "none" and manual:
            # The class was raised to manual since: asked now.
            t["state"] = "requested"
            t["asks"] += 1
        if t["state"] == "none":
            return 0, {**base, "decision": "autonomous", "state": None, "seq": None, "idempotent": True}, None
        return 0, {**base, "decision": "requested", "state": t["state"], "seq": 4, "idempotent": True}, None

    def _wait(self, pos, flags):
        assert flags == {"--timeout": "0", "--json": True}
        self.waits += 1
        if self.on_wait is not None:
            forced = self.on_wait(self.waits)
            if forced is not None:
                return forced
        task = pos[0]
        t = self.tasks.get(task)
        if t is None:
            return self._error("not-registered")
        doc = {"task": task, "actions": []}
        state = t["state"]
        if t["executed"] or state == "none":
            return 0, {**doc, "ok": True, "status": "nothing-to-wait-for"}, None
        if state == "requested":
            return 6, None, {**doc, "ok": False, "status": "timeout"}
        if state == "granted":
            return 0, {**doc, "ok": True, "status": "granted"}, None
        if state in ("rejected", "withdrawn"):
            return 1, None, {**doc, "ok": False, "status": state}
        if state == "expired":
            return 3, None, {**doc, "ok": False, "status": "expired"}
        if state == "void":
            return 7, None, {**doc, "ok": False, "status": "void"}
        raise AssertionError(state)

    def _start(self, pos, flags):
        if self.start_answer is not None:
            return self.start_answer
        task = pos[0]
        t = self.tasks.get(task)
        if t is None:
            return self._error("not-registered")
        assert flags["--action"] == t["key"]
        phash = hashlib.sha256(json.dumps(json.loads(flags["--payload-json"]), sort_keys=True,
                                          separators=(",", ":")).encode()).hexdigest()
        if phash != t["hash"]:
            return self._error("payload-mismatch")
        manual = self.autonomy.get(t["class"]) == "manual"
        if t["executed"]:
            return self._error("not-granted" if manual else "already-executed")
        if t["state"] == "void":
            return self._error("policy-drift")
        if t["state"] == "expired":
            return self._error("expired")
        if t["state"] == "granted":
            t["executed"] = True
            return 0, {"ok": True, "task": task, "action_key": t["key"], "class": t["class"],
                       "authorization": "grant", "seq": 6}, None
        if t["state"] == "none" and not manual:
            t["executed"] = True
            return 0, {"ok": True, "task": task, "action_key": t["key"], "class": t["class"],
                       "authorization": "policy", "seq": 8}, None
        return self._error("not-granted")

    def _withdraw(self, pos, flags):
        t = self.tasks.get(pos[0])
        if t is None or t["state"] != "requested":
            return self._error("not-pending")
        t["state"] = "withdrawn"
        return 0, {"ok": True}, None


class ToolFireCtx:
    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.tools: dict[str, dict] = {}

    def register_hook(self, hook_name, callback):  # noqa: ANN001
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                      is_async=False, description="", emoji="", override=False):  # noqa: ANN001
        self.tools[name] = {"handler": handler, "description": description}
        return object()

    def fire(self, hook_name: str, **kwargs: Any) -> None:
        for callback in self.hooks.get(hook_name, []):
            callback(**kwargs)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture()
def mods(plugin, av):
    name = av.MODULE_NAME
    return type("Mods", (), {
        "ri": sys.modules[f"{name}._record_intention"],
        "ia": sys.modules[f"{name}._intent_approval"],
        "ap": sys.modules[f"{name}._approval"],
        "core": sys.modules[f"{name}._core"],
    })


@pytest.fixture()
def index(mods, monkeypatch):
    fake = FakeIndex()
    monkeypatch.setattr(mods.ri, "_OPENER", fake)
    return fake


@pytest.fixture()
def serve(mods, monkeypatch):
    fake = FakeServe()
    monkeypatch.setattr(mods.ap, "_transport", fake.transport)
    return fake


@pytest.fixture()
def kicks(mods, monkeypatch):
    """The poller is driven by hand: `ensure_poller` and `kick` only record."""
    seen: list[str] = []
    monkeypatch.setattr(mods.ap, "ensure_poller", lambda: seen.append("thread") or True)
    monkeypatch.setattr(mods.ap, "kick", lambda: seen.append("kick"))
    return seen


@pytest.fixture()
def on(monkeypatch, home):
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("INDEX_API_KEY", KEY)
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "1")
    monkeypatch.setenv("AV_APPROVAL_URL", FACADE)
    monkeypatch.setenv("AV_APPROVAL_TOKEN", TOKEN)


@pytest.fixture()
def tctx(plugin, index, serve, kicks, on, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return ctx


def call(ctx: ToolFireCtx, args: dict, *, session: str = SESSION, tool_call_id: str = "call-1") -> dict:
    handler = ctx.tools["record_intention"]["handler"]
    result = handler(args, task_id="task-1", session_id=session)
    ctx.fire("post_tool_call", tool_name="record_intention", args=args, result=result, session_id=session,
             task_id="task-1", turn_id="turn-1", tool_call_id=tool_call_id, api_request_id="req-1",
             duration_ms=50, status="error" if '"error"' in result else "ok", error_type=None, error_message=None)
    return json.loads(result)


def events(av, plugin) -> list[dict]:
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("intention.")]


def entry(mods, intention_id: str) -> dict:
    return mods.ri._load_map()[intention_id]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def poll(mods) -> None:
    mods.ia.run_intent_pass()


# --------------------------------------------------------------------------
# The inferred path: propose at capture, publish on the resident's grant
# --------------------------------------------------------------------------


def test_an_ambient_capture_proposes_the_text_and_never_touches_index(tctx, serve, index, mods, av, plugin):
    out = call(tctx, {"text": TEXT, "source": "ambient"})
    iid = out["intention_id"]
    assert out["success"] is True and out["held"] is True and out["published"] is False
    assert out["approval_state"] == "requested"
    assert "asked in their approval channel" in out["message"] and "not an approval" in out["message"]
    [p] = serve.proposals()
    assert p["positionals"] == []
    assert p["flags"]["--class"] == INFERRED
    assert p["flags"]["--key"] == f"{INFERRED}:{iid}"
    assert p["flags"]["--payload-json"] == json.dumps({"text": TEXT}, ensure_ascii=False, separators=(",", ":"))
    # The summary is in the daemon's log in cleartext: none of the text.
    summary = p["flags"]["--summary"]
    assert iid in summary and TEXT not in summary
    assert not any(word in summary for word in ("climbing", "Goa", "weekends"))
    assert index.requests == []
    [event] = events(av, plugin)
    assert event["event_type"] == "intention.captured" and event["intention_id"] == iid
    assert event["payload"]["source"] == "ambient" and event["payload"]["index_intent_id"] is None
    assert event["payload"]["approval_state"] == "requested"
    assert TEXT not in json.dumps(event)


def test_the_held_text_is_in_the_private_map_until_the_proposal_ends(tctx, serve, index, mods, home):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    path = Path(mods.ri.map_path())
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    ap = entry(mods, iid)["approval"]
    assert json.loads(ap["payload"]) == {"text": TEXT}
    assert ap["state"] == "requested" and ap["task"] == task_id(INFERRED, f"{INFERRED}:{iid}")
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    assert TEXT not in path.read_text(encoding="utf-8")
    assert "payload" not in entry(mods, iid)["approval"]


def test_a_grant_publishes_the_exact_bytes_once_with_the_source_id(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    poll(mods)  # still pending: one wait, nothing else
    assert serve.verbs() == ["propose", "wait"] and index.requests == []
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    proposed = serve.proposals()[0]["flags"]["--payload-json"]
    [started] = [c for c in serve.calls if c["verb"] == "start"]
    assert started["flags"]["--payload-json"] == proposed  # the same bytes, character for character
    assert started["flags"]["--action"] == f"{INFERRED}:{iid}"
    [create] = index.creates()
    assert create["body"] == {"description": TEXT, "sourceType": "agentvillage", "sourceId": iid}
    assert create["body"]["description"] == json.loads(proposed)["text"]
    e = entry(mods, iid)
    assert e["published"] is True and e["index_intent_id"] == INDEX_ID and "held_norm_hash" not in e
    assert e["approval"]["state"] == "published" and e["approval"]["authorization"] == "grant"
    updated = [ev for ev in events(av, plugin) if ev["event_type"] == "intention.updated"]
    assert len(updated) == 1
    payload = updated[0]["payload"]
    assert updated[0]["intention_id"] == iid and payload["index_intent_id"] == INDEX_ID
    assert payload["approved_by"] == "individual" and payload["approval_state"] == "published"
    assert payload["text_hash"] == sha(TEXT) and payload["source"] == "ambient"
    assert payload["capture_path"] == "record_intention" and payload["publish_refused"] is None
    # Later passes do nothing more.
    poll(mods)
    poll(mods)
    assert len(index.creates()) == 1 and serve.verbs().count("start") == 1


def test_a_rejection_drops_the_text_and_publishes_nothing(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.reject(f"{INFERRED}:{iid}")
    poll(mods)
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "rejected" and "payload" not in ap
    assert index.requests == [] and len(events(av, plugin)) == 1
    out = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c2")
    assert out["error"] == "resident_declined"
    poll(mods)
    assert serve.verbs().count("wait") == 1  # a terminal proposal is never polled again


def test_expiry_re_proposes_the_same_bytes_twice_then_gives_up(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    first = serve.proposals()[0]["flags"]["--payload-json"]
    for expected_asks in (2, 3):
        serve.expire(key)
        poll(mods)
        assert serve.tasks[task_id(INFERRED, key)]["asks"] == expected_asks
    assert {p["flags"]["--payload-json"] for p in serve.proposals()} == {first}
    serve.expire(key)
    poll(mods)
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "expired" and "payload" not in ap
    assert len(serve.proposals()) == 3 and index.requests == []


def test_a_stale_grant_after_a_policy_re_attest_is_never_spent(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    serve.grant(key)
    serve.reattest()  # the grant was pinned to the old policy
    poll(mods)
    # wait said void: the same bytes are proposed again, a new question; no start.
    assert serve.verbs() == ["propose", "wait", "propose"]
    assert serve.tasks[task_id(INFERRED, key)]["state"] == "requested"
    assert index.requests == []
    serve.grant(key)
    poll(mods)
    assert len(index.creates()) == 1


def test_policy_drift_at_start_re_proposes_instead_of_publishing(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    serve.grant(key)
    granted = (0, {"ok": True, "status": "granted", "task": "t", "actions": []}, None)

    def drift(n: int):
        if n == 2:  # the re-read reads granted, then the re-attest lands before start
            serve.reattest()
            return granted
        return None

    serve.on_wait = drift
    poll(mods)
    assert "start" in serve.verbs() and index.requests == []
    assert entry(mods, iid)["approval"]["state"] == "requested"  # re-proposed, a new question
    assert [p["flags"]["--payload-json"] for p in serve.proposals()][1] == serve.proposals()[0]["flags"]["--payload-json"]


def test_under_an_autonomous_inferred_policy_the_capture_publishes_at_once(tctx, serve, index, mods, av, plugin):
    serve.autonomy[INFERRED] = "autonomous"
    out = call(tctx, {"text": TEXT, "source": "ambient"})
    assert out["published"] is True and out["index_intent_id"] == INDEX_ID and out["approved_by"] == "rule"
    assert index.creates()[0]["body"]["sourceId"] == out["intention_id"]
    [event] = events(av, plugin)
    assert event["event_type"] == "intention.captured" and event["payload"]["approved_by"] == "rule"
    assert event["payload"]["index_intent_id"] == INDEX_ID and event["payload"]["source"] == "ambient"


def test_a_cron_session_explicit_capture_is_proposed_as_inferred(tctx, serve, index, mods):
    tctx.fire("on_session_start", session_id="cron_job_1", platform="cron")
    out = call(tctx, {"text": TEXT, "source": "message"}, session="cron_job_1")
    assert out["source"] == "ambient" and out["publish_refused"] == "held_cron"
    assert serve.proposals()[0]["flags"]["--class"] == INFERRED and index.requests == []


# --------------------------------------------------------------------------
# The stated path
# --------------------------------------------------------------------------


def test_a_stated_capture_is_proposed_and_published_in_the_same_call(tctx, serve, index, mods, av, plugin):
    out = call(tctx, {"text": STATED, "source": "message"})
    iid = out["intention_id"]
    assert out["published"] is True and out["index_intent_id"] == INDEX_ID and iid != INDEX_ID
    assert out["approved_by"] == "rule" and out["approval_state"] == "published"
    # propose, the same propose again after the claim (the authority re-read), start.
    assert serve.verbs() == ["propose", "propose", "start"]
    assert serve.proposals()[0]["flags"]["--class"] == STATED_CLASS
    assert serve.proposals()[0]["flags"]["--key"] == f"{STATED_CLASS}:{iid}"
    assert index.creates()[0]["body"] == {"description": STATED, "sourceType": "agentvillage", "sourceId": iid}
    [event] = events(av, plugin)
    assert event["event_type"] == "intention.captured" and event["intention_id"] == iid
    assert event["payload"]["index_intent_id"] == INDEX_ID and event["payload"]["source"] == "message"
    assert event["payload"]["approved_by"] == "rule"


def test_a_stated_capture_under_a_manual_policy_waits_for_the_resident(tctx, serve, index, mods, av, plugin):
    serve.autonomy[STATED_CLASS] = "manual"
    out = call(tctx, {"text": STATED, "source": "message"})
    iid = out["intention_id"]
    assert out["published"] is False and out["publish_refused"] == "approval_pending"
    assert index.requests == []
    serve.grant(f"{STATED_CLASS}:{iid}")
    poll(mods)
    assert index.creates()[0]["body"]["sourceId"] == iid
    kinds = [(e["event_type"], e["payload"].get("approved_by")) for e in events(av, plugin)]
    assert kinds == [("intention.captured", None), ("intention.updated", "individual")]


def test_without_an_index_key_a_stated_capture_proposes_nothing(tctx, serve, index, monkeypatch):
    monkeypatch.delenv("INDEX_API_KEY")
    out = call(tctx, {"text": STATED, "source": "message"})
    assert out["publish_refused"] == "no_key" and serve.calls == [] and index.requests == []


# --------------------------------------------------------------------------
# The daemon unreachable, and refusals
# --------------------------------------------------------------------------


def test_an_unreachable_daemon_holds_and_the_poller_files_it_later(tctx, serve, index, mods):
    serve.down = True
    held = call(tctx, {"text": TEXT, "source": "ambient"})
    stated = call(tctx, {"text": STATED, "source": "message"}, tool_call_id="c2")
    assert held["approval_state"] == "unfiled" and "retried automatically" in held["message"]
    assert stated["published"] is False and stated["publish_refused"] == "approval_unavailable"
    # S1: no later call may execute a policy-cleared start: the stated capture ends here.
    assert entry(mods, stated["intention_id"])["approval"]["state"] == "not_published"
    assert index.requests == []
    serve.down = False
    poll(mods)
    assert [p["flags"]["--class"] for p in serve.proposals()] == [INFERRED]
    assert index.requests == []


def test_a_class_the_policy_does_not_open_is_held_and_confirm_files_it_after_the_policy_changes(
        tctx, serve, index, mods):
    serve.requestable.discard(INFERRED)
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "refused" and ap["code"] == "class-not-agent-requestable" and "payload" in ap
    poll(mods)
    assert len(serve.proposals()) == 1  # refused is not retried by the poller
    serve.requestable.add(INFERRED)
    out = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c2")
    assert out["error"] == "awaiting_resident" and len(serve.proposals()) == 2
    assert entry(mods, iid)["approval"]["state"] == "requested" and index.requests == []


def test_an_oversized_text_is_held_without_a_proposal(tctx, serve, index, mods):
    out = call(tctx, {"text": "x" * 270_000, "source": "ambient"})
    assert out["held"] is True and out["approval_state"] == "unavailable" and serve.calls == []
    assert "approval" not in entry(mods, out["intention_id"])


# --------------------------------------------------------------------------
# No duplicate publish across restarts and races
# --------------------------------------------------------------------------


def test_a_start_whose_confirmation_was_lost_is_never_published(tctx, serve, index, mods):
    """(1)/(5): only a fresh `start` ok publishes. A spent grant reads
    nothing-to-wait-for (exit 0, not granted): never a reason to publish."""
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    serve.grant(key)
    serve.tasks[task_id(INFERRED, key)]["executed"] = True  # a previous process started, then died
    poll(mods)
    poll(mods)
    assert serve.verbs().count("start") == 0 and index.requests == []
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "start_unconfirmed" and "payload" not in ap
    assert call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c2")["error"] == "publish_failed"


def test_a_crash_while_publishing_is_never_sent_again(tctx, serve, index, mods, av, plugin, monkeypatch):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    now = time.time()
    monkeypatch.setattr(mods.ri, "_clock", lambda: now)
    # The previous process marked it publishing and died inside the Index call.
    mods.ia._set_state(iid, {"requested"}, "publishing", publishing_at=now - 5, task=task_id(INFERRED, f"{INFERRED}:{iid}"))
    poll(mods)
    assert index.requests == [] and entry(mods, iid)["approval"]["state"] == "publishing"  # maybe still in flight
    monkeypatch.setattr(mods.ri, "_clock", lambda: now + 120)
    poll(mods)
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "ambiguous" and "payload" not in ap and index.requests == []
    updated = [e for e in events(av, plugin) if e["event_type"] == "intention.updated"]
    assert updated[-1]["payload"]["publish_refused"] == "timeout" and updated[-1]["payload"]["index_intent_id"] is None


def test_a_reloaded_plugin_does_not_publish_a_published_intention_again(tctx, serve, index, mods, av, plugin, kicks):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    assert len(index.creates()) == 1
    fresh = av.load_plugin()  # a new process: the same map on disk
    ia = sys.modules[f"{av.MODULE_NAME}._intent_approval"]
    sys.modules[f"{av.MODULE_NAME}._approval"]._transport = serve.transport
    sys.modules[f"{av.MODULE_NAME}._record_intention"]._OPENER = index
    ia.run_intent_pass()
    assert len(index.creates()) == 1 and fresh is not None


def test_two_passes_racing_take_each_step_once(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    gate = threading.Event()
    real_open = index.open

    def slow_open(request, timeout=None):  # noqa: ANN001
        gate.wait(5)
        return real_open(request, timeout)

    index.open = slow_open  # type: ignore[method-assign]
    first = threading.Thread(target=lambda: mods.ia.advance(iid, emit=True))
    first.start()
    deadline = time.time() + 5
    while entry(mods, iid)["approval"]["state"] != "publishing" and time.time() < deadline:
        time.sleep(0.01)
    second = mods.ia.advance(iid, emit=True)  # finds it publishing (fresh): does nothing
    gate.set()
    first.join(5)
    assert second.state == "publishing"
    assert len(index.creates()) == 1 and serve.verbs().count("start") == 1


# --------------------------------------------------------------------------
# Index failures after the start
# --------------------------------------------------------------------------


def test_nothing_reached_index_so_the_publish_is_retried_once_in_the_same_call(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    index.answers = [urllib.error.URLError(ConnectionRefusedError())]
    poll(mods)
    assert len(index.creates()) == 2 and entry(mods, iid)["published"] is True
    assert serve.verbs().count("start") == 1  # one execution, two attempts


def test_index_failing_twice_ends_it_without_a_later_retry(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    index.answers = [urllib.error.URLError(ConnectionRefusedError()), http_error(503)]
    poll(mods)
    poll(mods)
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "index_failed" and ap["code"] == "http_503" and "payload" not in ap
    assert len(index.creates()) == 2 and serve.verbs().count("start") == 1
    assert events(av, plugin)[-1]["payload"]["publish_refused"] == "http_503"


def test_index_refusing_the_text_is_final(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    index.answers = [http_error(422)]
    poll(mods)
    e = entry(mods, iid)
    assert e["approval"]["state"] == "index_rejected" and e["refused"] == "rejected" and "payload" not in e["approval"]
    assert events(av, plugin)[-1]["payload"]["publish_refused"] == "rejected"
    out = call(tctx, {"action": "update", "intention_id": iid, "text": TEXT + "!"}, tool_call_id="c2")
    assert out["error"] == "capture_again"
    poll(mods)
    assert len(index.creates()) == 1


def test_an_ambiguous_index_answer_is_never_retried(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    index.answers = [http_error(502)]
    poll(mods)
    poll(mods)
    assert entry(mods, iid)["approval"]["state"] == "ambiguous" and len(index.creates()) == 1


def test_the_rate_cap_holds_the_start_back(tctx, serve, index, mods, monkeypatch):
    monkeypatch.setenv("AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR", "0")
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    assert "start" not in serve.verbs() and entry(mods, iid)["approval"]["code"] == "rate_capped"
    monkeypatch.setenv("AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR", "5")
    poll(mods)
    assert len(index.creates()) == 1


# --------------------------------------------------------------------------
# confirm, update, withdraw
# --------------------------------------------------------------------------


def test_confirm_checks_the_resident_answer_and_publishes_once(tctx, serve, index, mods, av, plugin):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    out = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c2")
    # (4) a manual class with no grant: confirm refuses, starts nothing.
    assert out["success"] is False and out["error"] == "awaiting_resident"
    assert "cannot confirm it for them" in out["message"] and index.requests == []
    assert "start" not in serve.verbs()
    serve.grant(f"{INFERRED}:{iid}")
    out = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c3")
    assert out["published"] is True and out["index_intent_id"] == INDEX_ID and out["approved_by"] == "individual"
    # The confirm call's own result records nothing; the one event is the emitter's.
    kinds = [e["event_type"] for e in events(av, plugin)]
    assert kinds == ["intention.captured", "intention.updated"]
    again = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c4")
    assert again["published"] is True and len(index.creates()) == 1


def test_confirm_refusals(tctx, serve, index, mods, monkeypatch):
    assert call(tctx, {"action": "confirm"})["error"] == "intention_id_required"
    assert call(tctx, {"action": "confirm", "intention_id": "never-seen"})["error"] == "confirm_unknown"
    local = call(tctx, {"text": TEXT, "source": "message", "publish": False, "reason": "personal"})
    assert call(tctx, {"action": "confirm", "intention_id": local["intention_id"]})["error"] == "confirm_not_held"
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "0")
    old = call(tctx, {"text": TEXT + " old", "source": "ambient"})
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "1")
    assert call(tctx, {"action": "confirm", "intention_id": old["intention_id"]})["error"] == "confirm_text_missing"


def test_update_of_a_pending_intention_is_refused_and_withdraw_ends_it(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    out = call(tctx, {"action": "update", "intention_id": iid, "text": TEXT + "!"}, tool_call_id="c2")
    assert out["error"] == "approval_pending"
    assert json.loads(entry(mods, iid)["approval"]["payload"]) == {"text": TEXT}
    out = call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c3")
    assert out["success"] is True and out["published"] is False
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "withdrawn" and "payload" not in ap
    assert serve.verbs()[-1] == "withdraw"
    assert serve.tasks[task_id(INFERRED, f"{INFERRED}:{iid}")]["state"] == "withdrawn"
    poll(mods)
    assert index.requests == []


def test_a_grant_after_the_agent_withdrew_publishes_nothing(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")  # answered before the withdrawal reached the map
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c2")
    poll(mods)
    assert index.requests == [] and "start" not in serve.verbs()


def test_update_and_withdraw_of_an_approved_intention_mirror_to_the_index_id(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    index.requests.clear()
    up = call(tctx, {"action": "update", "intention_id": iid, "text": TEXT + " and bouldering"}, tool_call_id="c2")
    # Security review 2, item 1: new words never reach Index unapproved.
    assert up["index_intent_id"] == INDEX_ID and up["publish_refused"] == "approval_required"
    assert index.requests == []
    index.default = {"success": True}
    call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="c3")
    assert [(r["method"], r["path"]) for r in index.requests] == [("PATCH", f"/api/intents/{INDEX_ID}/archive")]


# --------------------------------------------------------------------------
# No text in logs; the token
# --------------------------------------------------------------------------


def test_no_text_or_token_in_any_log_line_or_request_header(tctx, serve, index, mods, caplog):
    with caplog.at_level(logging.DEBUG, logger="av-events"):
        iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
        call(tctx, {"text": STATED, "source": "message"}, tool_call_id="c2")
        serve.grant(f"{INFERRED}:{iid}")
        poll(mods)
        serve.down = True
        call(tctx, {"text": TEXT + " again", "source": "ambient"}, tool_call_id="c3")
    for secret in (TEXT, STATED, TOKEN, KEY, "climbing", "founders"):
        assert secret not in caplog.text
    assert TOKEN not in mods.core.sanitize(f"x {TOKEN}")
    # An https facade gets the credential in both headers (Maritime strips Authorization).
    assert serve.headers[0]["X-Approval-Authorization"] == f"Bearer {TOKEN}"


def test_the_token_file_wins_and_a_bad_one_never_falls_back(mods, home, monkeypatch):
    path = home / "approval" / "agent-token"
    path.parent.mkdir(mode=0o700)
    path.write_text("file-token-value-0001\n", encoding="utf-8")
    os.chmod(path, 0o600)
    monkeypatch.setenv("AV_APPROVAL_TOKEN", "env-token-value-00001")
    assert mods.ap.agent_token() == ("file-token-value-0001", None)  # the default file, before the variable
    os.chmod(path, 0o644)
    assert mods.ap.agent_token() == (None, "token_file_mode")
    named = home / "named-token"
    named.write_text("named-token-value-001", encoding="utf-8")
    os.chmod(named, 0o600)
    monkeypatch.setenv("AV_APPROVAL_TOKEN_FILE", str(named))
    assert mods.ap.agent_token() == ("named-token-value-001", None)
    monkeypatch.setenv("AV_APPROVAL_TOKEN_FILE", str(home / "missing"))
    assert mods.ap.agent_token() == (None, "token_file_missing")
    monkeypatch.setenv("AV_APPROVAL_TOKEN_FILE", "relative/path")
    assert mods.ap.agent_token() == (None, "token_file_not_absolute")


@pytest.mark.parametrize(
    "url,kind",
    [
        ("http://127.0.0.1:4682", "loopback"),
        ("http://localhost:4682/", "loopback"),
        ("http://[::1]:4682", "loopback"),
        ("unix:/run/approval/serve.sock", "unix"),
        ("https://approval.example", "https"),
        ("https://approval.example:8443/", "https"),
        ("http://127.0.0.1", None),
        ("http://approval.example:4682", None),
        ("http://10.0.0.2:4682", None),
        ("https://approval.example/verb", None),
        ("https://user:pw@approval.example", None),
        ("https://approval.example?x=1", None),
        ("unix:relative.sock", None),
        ("unix:/a/../b.sock", None),
        ("ftp://approval.example", None),
        ("http://127.0.0.1:4682\n", None),
        ("", None),
    ],
)
def test_the_url_shapes(mods, url, kind):
    endpoint = mods.ap.parse_endpoint(url)
    assert (endpoint.kind if endpoint else None) == kind


# --------------------------------------------------------------------------
# Real transport: a loopback port and a unix socket, with the listener check
# --------------------------------------------------------------------------


class _VerbHandler(BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        type(self).seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        out = {"ok": True, "task": "propose:" + "a" * 32, "status": "timeout"}
        answer = {"exit_code": 6, "stdout": "", "stderr": json.dumps(out) + "\n",
                  "stdout_truncated": False, "stderr_truncated": False}
        raw = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):  # noqa: A003
        return


def _fake_proc(root: Path, port: int, uid: int) -> None:
    (root / "net").mkdir(parents=True, exist_ok=True)
    header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
    line = f"   0: 0100007F:{port:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 {uid:>5}        0 1 1\n"
    (root / "net" / "tcp").write_text(header + line, encoding="ascii")
    (root / "net" / "tcp6").write_text(header, encoding="ascii")


def test_loopback_transport_and_the_listener_check(mods, home, monkeypatch, tmp_path):
    _VerbHandler.seen = []
    server = HTTPServer(("127.0.0.1", 0), _VerbHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        monkeypatch.setenv("AV_APPROVAL_URL", f"http://127.0.0.1:{port}")
        monkeypatch.setenv("AV_APPROVAL_TOKEN", TOKEN)
        monkeypatch.setattr(mods.ap, "PROC_ROOT", str(tmp_path / "proc"))
        monkeypatch.setenv("AV_APPROVAL_DAEMON_UID", str(os.geteuid()))
        _fake_proc(tmp_path / "proc", port, os.geteuid())
        answer = mods.ap.wait("propose:" + "a" * 32)
        assert answer.exit_code == 6 and answer.status == "timeout"
        [req] = _VerbHandler.seen
        assert req["path"] == "/verb/wait" and req["auth"] == f"Bearer {TOKEN}"
        assert json.loads(req["body"]) == {"positionals": ["propose:" + "a" * 32],
                                           "flags": {"--timeout": "0", "--json": True}}
        # The port held by another uid: nothing is sent, not even the credential.
        _fake_proc(tmp_path / "proc", port, os.geteuid() + 1)
        with pytest.raises(mods.ap.ApprovalUnavailable) as caught:
            mods.ap.wait("propose:" + "a" * 32)
        assert caught.value.code == "facade_listener_foreign" and len(_VerbHandler.seen) == 1
        # Nothing listening in the table: also refused.
        _fake_proc(tmp_path / "proc", port + 1, os.geteuid())
        with pytest.raises(mods.ap.ApprovalUnavailable):
            mods.ap.wait("propose:" + "a" * 32)
        assert len(_VerbHandler.seen) == 1
    finally:
        server.shutdown()
        server.server_close()


def test_unix_socket_transport_and_its_ownership_check(mods, home, monkeypatch):
    import tempfile

    sockdir = Path(tempfile.mkdtemp(prefix="avap-", dir="/tmp"))
    os.chmod(sockdir, 0o700)
    path = sockdir / "s.sock"

    class UnixHTTPServer(HTTPServer):
        address_family = socket.AF_UNIX

        def server_bind(self):  # noqa: D401
            self.socket.bind(self.server_address)
            self.server_name, self.server_port = "localhost", 0

    _VerbHandler.seen = []
    server = UnixHTTPServer(str(path), _VerbHandler)
    server.get_request = lambda: (server.socket.accept()[0], ("local", 0))  # type: ignore[method-assign]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("AV_APPROVAL_URL", f"unix:{path}")
        monkeypatch.setenv("AV_APPROVAL_TOKEN", TOKEN)
        monkeypatch.setenv("AV_APPROVAL_DAEMON_UID", str(os.geteuid()))
        assert mods.ap.wait("propose:" + "b" * 32).exit_code == 6
        assert len(_VerbHandler.seen) == 1
        os.chmod(sockdir, 0o777)
        with pytest.raises(mods.ap.ApprovalUnavailable) as caught:
            mods.ap.wait("propose:" + "b" * 32)
        assert caught.value.code == "facade_listener_foreign" and len(_VerbHandler.seen) == 1
        os.chmod(sockdir, 0o700)
        monkeypatch.setenv("AV_APPROVAL_DAEMON_UID", "10001")
        with pytest.raises(mods.ap.ApprovalUnavailable):
            mods.ap.wait("propose:" + "b" * 32)
    finally:
        server.shutdown()
        server.server_close()
        try:
            path.unlink()
            sockdir.rmdir()
        except OSError:
            pass


# --------------------------------------------------------------------------
# The poller's lifecycle
# --------------------------------------------------------------------------


def test_the_poller_starts_only_in_the_gateway(mods, on, kicks, monkeypatch):
    assert mods.ia.maybe_start("telegram") == "thread"
    assert mods.ia.maybe_start("cron") == "thread"
    assert mods.ia.maybe_start("cli") == "pass"
    assert mods.ia.maybe_start(None, argv=["hermes", "gateway", "run"]) == "thread"
    # S3: registration outside `hermes gateway run` kicks nothing.
    assert mods.ia.maybe_start(None, argv=["hermes", "chat", "-q", "x"]) == "idle"
    assert mods.ia.maybe_start(None, argv=["hermes", "dashboard"]) == "idle"
    monkeypatch.setenv("AV_APPROVAL_POLLER", "0")
    assert mods.ia.maybe_start("telegram") == "pass"
    monkeypatch.setenv("AV_APPROVAL_POLLER", "1")
    assert mods.ia.maybe_start("cli") == "thread"
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "0")
    assert mods.ia.maybe_start("telegram") == "off"


def test_a_session_start_resumes_pending_proposals(tctx, kicks):
    kicks.clear()
    tctx.fire("on_session_start", session_id="s2", platform="cli")
    assert kicks == ["kick"]
    tctx.fire("on_session_start", session_id="s3", platform="telegram")
    assert kicks[-2:] == ["thread", "kick"]


def test_the_poller_thread_survives_a_failing_pass_and_stops_on_unload(mods, on, plugin, monkeypatch):
    monkeypatch.setenv("AV_APPROVAL_POLL_S", "5")
    runs: list[int] = []
    done = threading.Event()

    def flaky(_execute: bool) -> None:
        runs.append(1)
        if len(runs) == 1:
            raise RuntimeError("boom")
        done.set()

    monkeypatch.setattr(mods.ap, "_PASSES", {"flaky": flaky})
    monkeypatch.setattr(mods.ap, "MIN_POLL_S", 0.01)
    monkeypatch.setattr(mods.ap, "poll_interval", lambda: 0.01)
    try:
        assert mods.ap.ensure_poller() is True
        assert done.wait(5) and mods.ap.poller_alive()
        thread = mods.ap._poller
        assert mods.ap.ensure_poller() is True and mods.ap._poller is thread  # one thread per process
        plugin._on_unload()
        thread.join(5)
        assert not thread.is_alive() and not mods.ap.poller_alive()
        # A thread that is gone is replaced at the next start.
        assert mods.ap.ensure_poller() is True and mods.ap._poller is not thread
    finally:
        mods.ap.stop_poller()


def test_a_pass_running_elsewhere_is_skipped(mods, home, monkeypatch):
    import fcntl

    ran: list[int] = []
    monkeypatch.setattr(mods.ap, "_PASSES", {"p": lambda _execute: ran.append(1)})
    os.makedirs(os.path.dirname(mods.ap.pass_lock_path()), exist_ok=True)
    fd = os.open(mods.ap.pass_lock_path(), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)  # another process holds it (flock is per open file)
        assert mods.ap.run_pass() is False and ran == []
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    assert mods.ap.run_pass() is True and ran == [1]


def test_with_approval_off_nothing_is_proposed(plugin, index, serve, kicks, on, monkeypatch, av):
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "0")
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, platform="telegram")
    held = call(ctx, {"text": TEXT, "source": "ambient"})
    stated = call(ctx, {"text": STATED, "source": "message"}, tool_call_id="c2")
    assert serve.calls == [] and "approval_state" not in held
    assert stated["intention_id"] == INDEX_ID  # the DATA-249 shape: Index's id
    assert call(ctx, {"action": "confirm", "intention_id": held["intention_id"]})["error"] == "confirmation_not_wired"


# --------------------------------------------------------------------------
# The security review's five shapes
# --------------------------------------------------------------------------


@pytest.mark.parametrize("forged", ["cleared", "granted", "started", "published"])
def test_1_map_state_alone_never_publishes(tctx, serve, index, mods, forged):
    """A manual proposal whose map entry claims more than the daemon says."""
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]

    def forge(_entry: dict, ap: dict) -> None:
        ap["state"] = forged

    mods.ia._cas(iid, None, forge)
    poll(mods)
    out = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c2")
    assert index.requests == [] and "start" not in serve.verbs()
    assert out["success"] is False or out["published"] is False


def test_1_a_start_without_the_expected_authorization_never_publishes(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    serve.start_answer = (0, {"ok": True, "task": "x", "action_key": "y", "class": INFERRED, "seq": 6}, None)
    poll(mods)
    assert index.requests == [] and entry(mods, iid)["approval"]["code"] == "authorization_mismatch"
    serve.start_answer = (0, {"ok": True, "authorization": "policy", "seq": 6}, None)  # a rule, not the grant read
    iid2 = call(tctx, {"text": TEXT + " 2", "source": "ambient"}, tool_call_id="c2")["intention_id"]
    serve.grant(f"{INFERRED}:{iid2}")
    poll(mods)
    assert index.requests == []


def test_1_start_only_after_a_fresh_granted_read_twice(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    verbs = serve.verbs()
    # A wait that read granted, the claim, a second wait that read granted, then start.
    assert verbs[verbs.index("start") - 2:verbs.index("start")] == ["wait", "wait"]
    assert len(index.creates()) == 1


def test_2_held_bytes_that_no_longer_hash_to_the_proposal_are_never_published(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")

    def tamper(_entry: dict, ap: dict) -> None:
        ap["payload"] = json.dumps({"text": "Something else entirely"}, separators=(",", ":"))

    mods.ia._cas(iid, None, tamper)
    poll(mods)
    # Re-proposed with the bytes now held; core binds the key to the first bytes and refuses.
    assert serve.proposals()[-1]["flags"]["--payload-json"] != serve.proposals()[0]["flags"]["--payload-json"]
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "refused" and ap["code"] == "payload-mismatch"
    assert index.requests == [] and "start" not in serve.verbs()


def test_2_a_hash_core_registered_for_other_bytes_is_refused_at_propose(tctx, serve, index, mods):
    serve.hash_lie = True
    out = call(tctx, {"text": TEXT, "source": "ambient"})
    ap = entry(mods, out["intention_id"])["approval"]
    assert ap["state"] == "refused" and ap["code"] == "payload_hash_mismatch"
    stated = call(tctx, {"text": STATED, "source": "message"}, tool_call_id="c2")
    assert stated["published"] is False and index.requests == []


def test_2_the_local_hash_is_cores_payload_hash():
    """The held string is its own JCS form; the value core answered on a real
    `approval serve` (PR #569 build) for this payload."""
    payload = json.dumps({"text": "Looking for a climbing partner"}, ensure_ascii=False, separators=(",", ":"))
    assert hashlib.sha256(payload.encode()).hexdigest() == "1015051333d1581f989bfd9b7735e931a3a54959e571060c72ce7bf9d443d24a"


def test_3_the_authority_is_read_again_after_the_claim(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    serve.grant(key)

    def flip(n: int):
        if n == 2:  # the re-read after the claim: rejected meanwhile
            serve.tasks[task_id(INFERRED, key)]["state"] = "rejected"
        return None

    serve.on_wait = flip
    poll(mods)
    assert "start" not in serve.verbs() and index.requests == []
    assert entry(mods, iid)["approval"]["state"] == "requested"  # released; the next read finds the rejection
    poll(mods)
    assert entry(mods, iid)["approval"]["state"] == "rejected"


def test_3_a_withdraw_while_claimed_is_refused_and_nothing_publishes_after_a_withdraw(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    serve.grant(key)
    seen: list[dict] = []

    def withdraw_midway(n: int):
        if n == 2:
            seen.append(call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="w"))
        return None

    serve.on_wait = withdraw_midway
    poll(mods)
    assert seen[0]["error"] == "approval_publishing" and len(index.creates()) == 1  # the claim held
    iid2 = call(tctx, {"text": TEXT + " 2", "source": "ambient"}, tool_call_id="c2")["intention_id"]
    serve.grant(f"{INFERRED}:{iid2}")
    call(tctx, {"action": "withdraw", "intention_id": iid2}, tool_call_id="c3")
    serve.on_wait = None
    poll(mods)
    assert len(index.creates()) == 1


def test_3_an_abandoned_claim_is_released_and_asked_again(tctx, serve, index, mods, monkeypatch):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    now = time.time()
    monkeypatch.setattr(mods.ri, "_clock", lambda: now)

    def claimed(_entry: dict, ap: dict) -> None:
        ap.update(state="starting", claim="dead-claim", back="requested", claimed_at=now - 10)

    mods.ia._cas(iid, None, claimed)
    poll(mods)
    assert index.requests == [] and entry(mods, iid)["approval"]["state"] == "starting"  # maybe still alive
    monkeypatch.setattr(mods.ri, "_clock", lambda: now + 600)
    poll(mods)
    assert len(index.creates()) == 1 and serve.verbs().count("start") == 1


@pytest.mark.parametrize("answer", [
    (0, {"ok": True, "status": "nothing-to-wait-for", "task": "t", "actions": []}, None),
    (0, {"ok": True, "status": "executed", "task": "t", "actions": []}, None),
    (0, {"ok": True, "status": "something-new", "task": "t", "actions": []}, None),
    (2, None, {"ok": False, "error": {"code": "usage", "message": "x"}}),
    (9, {"ok": True, "status": "granted", "task": "t", "actions": []}, None),
    (6, None, {"ok": False, "status": "timeout"}),
])
def test_5_only_exit_0_granted_is_a_grant(tctx, serve, index, mods, answer):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")  # the daemon has a grant, but the answer the plugin reads says otherwise
    serve.on_wait = lambda n: answer
    poll(mods)
    out = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c2")
    assert "start" not in serve.verbs() and index.requests == []
    assert out["success"] is False


def test_4_confirm_on_a_forged_cleared_manual_proposal_publishes_nothing(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    mods.ia._cas(iid, None, lambda _e, ap: ap.__setitem__("state", "cleared"))
    out = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c2")
    # S1: confirm never executes a policy-cleared start; the forged entry ends.
    assert out["error"] == "rule_needs_capture" and index.requests == [] and "start" not in serve.verbs()


# --------------------------------------------------------------------------
# Refuter round on #174: B1, S1..S4, L1, L5
# --------------------------------------------------------------------------


def _refused_entry(tctx, serve, mods) -> str:
    serve.requestable.discard(STATED_CLASS)
    out = call(tctx, {"text": STATED, "source": "message"}, tool_call_id="r1")
    assert entry(mods, out["intention_id"])["approval"]["state"] == "refused"
    serve.requestable.add(STATED_CLASS)
    return out["intention_id"]


def test_b1_withdraw_ends_a_refused_proposal_and_confirm_cannot_reopen_it(tctx, serve, index, mods):
    iid = _refused_entry(tctx, serve, mods)
    out = call(tctx, {"action": "withdraw", "intention_id": iid}, tool_call_id="w")
    assert out["success"] is True
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "withdrawn" and "payload" not in ap
    assert call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c")["error"] == "confirm_not_held"
    assert mods.ia.reopen(iid) is False
    assert index.requests == [] and "start" not in serve.verbs()


def test_b1_update_ends_a_refused_proposal(tctx, serve, index, mods):
    iid = _refused_entry(tctx, serve, mods)
    out = call(tctx, {"action": "update", "intention_id": iid, "text": STATED + " now"}, tool_call_id="u")
    assert out["success"] is True and out["published"] is False
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "superseded" and "payload" not in ap
    assert call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c")["error"] == "confirm_not_held"
    assert index.requests == []


def test_b1_confirm_never_publishes_a_refused_stated_proposal_on_a_rule(tctx, serve, index, mods):
    """The old shape: refused, then reopened by confirm, then cleared by the policy."""
    iid = _refused_entry(tctx, serve, mods)
    out = call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c")
    assert out["error"] == "rule_needs_capture"
    assert index.requests == [] and "start" not in serve.verbs()


@pytest.mark.parametrize("field,value", [
    ("class", "intent.publish.anything.else"),
    ("key", f"{INFERRED}:someone-elses-id"),
    ("key", f"{STATED_CLASS}:x"),
])
def test_s1_a_forged_class_or_key_is_never_proposed_or_started(tctx, serve, index, mods, field, value):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    mods.ia._cas(iid, None, lambda _e, ap: ap.__setitem__(field, value))
    poll(mods)
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "invalid" and "payload" not in ap
    assert "start" not in serve.verbs() and index.requests == []


def test_s1_the_poller_and_confirm_never_execute_a_policy_cleared_start(tctx, serve, index, mods):
    serve.autonomy[INFERRED] = "autonomous"
    serve.down = True
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.down = False
    poll(mods)  # proposes; the policy clears it; no capture call is there to execute it
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "not_published" and "payload" not in ap
    assert "start" not in serve.verbs() and index.requests == []
    assert call(tctx, {"action": "confirm", "intention_id": iid}, tool_call_id="c")["error"] == "rule_needs_capture"


def test_s1_the_source_id_is_the_keys_id(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    poll(mods)
    assert index.creates()[0]["body"]["sourceId"] == iid == entry(mods, iid)["approval"]["key"].split(":", 1)[1]


def test_s2_the_gate_settings_come_from_the_process_environment_only(mods, home, monkeypatch):
    (home / ".env").write_text(
        "AV_APPROVAL_ENABLED=1\nAV_APPROVAL_URL=http://127.0.0.1:9\nAV_APPROVAL_DAEMON_UID=0\n", encoding="utf-8")
    assert mods.ap.enabled() is False and mods.ap.configured() is False
    assert mods.ap.daemon_uid() == 10001
    monkeypatch.setenv("AV_APPROVAL_TOKEN", TOKEN)
    with pytest.raises(mods.ap.ApprovalUnavailable) as caught:
        mods.ap.wait("propose:" + "c" * 32)
    assert caught.value.code == "url_missing"
    monkeypatch.setenv("AV_PROC_ROOT", "/nonexistent")
    assert mods.ap._proc_root() == "/proc"


def test_s3_a_one_shot_resume_pass_stops_before_start(tctx, serve, index, mods):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.grant(f"{INFERRED}:{iid}")
    mods.ap.register_pass("intents", mods.ia.run_intent_pass)
    assert mods.ap.run_pass(execute=False) is True
    assert "start" not in serve.verbs() and index.requests == []
    assert entry(mods, iid)["approval"]["state"] == "requested"
    assert mods.ap.run_pass(execute=True) is True  # the gateway's poller
    assert len(index.creates()) == 1


def test_s3_registration_outside_the_gateway_kicks_no_pass(plugin, index, serve, kicks, on, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["hermes", "chat", "-q", "hi"])
    plugin.register(ToolFireCtx())
    assert kicks == []
    plugin._on_unload()
    plugin._REGISTERED = False
    monkeypatch.setattr(sys, "argv", ["hermes", "gateway", "run"])
    plugin.register(ToolFireCtx())
    assert kicks == ["thread", "kick"]


@pytest.mark.parametrize("answer", [
    (1, None, {"ok": False, "status": "timeout", "task": "t"}),
    (1, None, {"ok": False, "error": {"code": "integrity", "message": "x"}}),
    (3, None, {"ok": False, "error": {"code": "torn-tail", "message": "x"}}),
    (7, None, {"ok": False, "status": "granted", "task": "t"}),
])
def test_s4_exit_codes_count_only_with_their_status(tctx, serve, index, mods, answer):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    serve.on_wait = lambda n: answer
    poll(mods)
    ap = entry(mods, iid)["approval"]
    assert ap["state"] == "requested" and "payload" in ap  # transient: asked again next pass
    assert len(serve.proposals()) == 1 and index.requests == []


def test_l1_an_unreadable_gate_switch_holds_a_stated_capture(tctx, serve, index, mods, monkeypatch):
    def boom() -> bool:
        raise RuntimeError("x")

    monkeypatch.setattr(mods.ia, "active", boom)
    out = call(tctx, {"text": STATED, "source": "message"})
    assert out["published"] is False and out["publish_refused"] == "approval_unavailable"
    assert index.requests == [] and serve.calls == []


def test_l5_a_symlinked_token_file_is_refused(mods, home, monkeypatch):
    real = home / "real-token"
    real.write_text("real-token-value-0001", encoding="utf-8")
    os.chmod(real, 0o600)
    link = home / "link-token"
    link.symlink_to(real)
    monkeypatch.setenv("AV_APPROVAL_TOKEN_FILE", str(link))
    assert mods.ap.agent_token() == (None, "token_file_missing")


def test_l6_a_contended_pass_logs_one_line(mods, home, monkeypatch, caplog):
    import fcntl

    monkeypatch.setattr(mods.ap, "_PASSES", {"p": lambda _execute: None})
    os.makedirs(os.path.dirname(mods.ap.pass_lock_path()), exist_ok=True)
    fd = os.open(mods.ap.pass_lock_path(), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        with caplog.at_level(logging.INFO, logger="av-events"):
            mods.ap.run_pass()
            mods.ap.run_pass()
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    assert caplog.text.count("pass_skipped=contended") == 1


# --------------------------------------------------------------------------
# Second security review: sibling paths, the resume pass, settings
# --------------------------------------------------------------------------


def test_sr2_1_no_index_create_without_the_gate_when_approval_is_on(tctx, serve, index, mods, monkeypatch):
    assert mods.ri.publish_intent(TEXT) == (None, "approval_required")
    assert mods.ri.publish_intent(TEXT, source_id="x", _gate=object()) == (None, "approval_required")
    # Approval unreadable: the same refusal (L1).
    monkeypatch.setattr(mods.ia, "active", lambda: (_ for _ in ()).throw(RuntimeError("x")))
    assert mods.ri.publish_intent(TEXT) == (None, "approval_required")
    assert index.requests == []


def test_sr2_1_every_capture_path_reaches_index_only_through_start(tctx, serve, index, mods):
    call(tctx, {"text": STATED, "source": "message"})
    call(tctx, {"text": STATED + " 2", "source": "note"}, tool_call_id="c2")
    call(tctx, {"text": TEXT, "source": "ambient"}, tool_call_id="c3")
    call(tctx, {"text": TEXT + " 3", "source": "message", "publish": False, "reason": "personal"}, tool_call_id="c4")
    creates = index.creates()
    starts = [c for c in serve.calls if c["verb"] == "start"]
    assert len(creates) == len(starts) == 2  # the two stated captures, each after its own start
    assert {c["body"]["sourceId"] for c in creates} == {s_["flags"]["--action"].split(":", 1)[1] for s_ in starts}


def test_sr2_1_an_update_of_a_published_intention_never_rewrites_it_on_index(tctx, serve, index, mods):
    out = call(tctx, {"text": STATED, "source": "message"})
    index.requests.clear()
    up = call(tctx, {"action": "update", "intention_id": out["intention_id"], "text": "Something unapproved"},
              tool_call_id="u")
    assert up["publish_refused"] == "approval_required" and index.requests == []


@pytest.mark.parametrize("setup", ["granted", "cleared", "stale_starting", "granted_after_void"])
def test_sr2_2_the_resume_pass_never_starts_or_publishes(tctx, serve, index, mods, monkeypatch, setup):
    iid = call(tctx, {"text": TEXT, "source": "ambient"})["intention_id"]
    key = f"{INFERRED}:{iid}"
    serve.grant(key)
    if setup == "cleared":
        mods.ia._cas(iid, None, lambda _e, ap: ap.__setitem__("state", "cleared"))
    elif setup == "stale_starting":
        mods.ia._cas(iid, None, lambda _e, ap: ap.update(state="starting", claim="c", back="requested", claimed_at=0.0))
    elif setup == "granted_after_void":
        serve.reattest()
        mods.ia.run_intent_pass(execute=False)  # re-proposes
        serve.grant(key)
    for _ in range(3):
        mods.ia.run_intent_pass(execute=False)
    assert "start" not in serve.verbs() and index.requests == []


def test_sr2_2_the_poller_switch_is_not_read_from_the_dotfile(mods, on, kicks, home):
    (home / ".env").write_text("AV_APPROVAL_POLLER=1\n", encoding="utf-8")
    assert mods.ia.maybe_start("cli") == "pass"  # a one-shot pass, never the executing thread
    assert "thread" not in kicks


def test_sr2_3_no_approval_setting_is_read_from_the_dotfile(mods, home, monkeypatch):
    token = home / "dotfile-token"
    token.write_text("dotfile-token-value-01", encoding="utf-8")
    os.chmod(token, 0o600)
    (home / ".env").write_text(
        "AV_APPROVAL_ENABLED=1\nAV_APPROVAL_URL=http://127.0.0.1:9\nAV_APPROVAL_DAEMON_UID=0\n"
        f"AV_APPROVAL_TOKEN_FILE={token}\nAV_APPROVAL_TOKEN=dotfile-token-value-02\n"
        "AV_APPROVAL_POLL_S=5\nAV_APPROVAL_POLLER=1\nAV_PROC_ROOT=/tmp\n", encoding="utf-8")
    assert mods.ap.enabled() is False and mods.ap.configured() is False
    assert mods.ap.daemon_uid() == 10001
    assert mods.ap.agent_token() == (None, "token_missing")
    assert mods.ap.poll_interval() == mods.ap.DEFAULT_POLL_S
    assert mods.ap._proc_root() == "/proc"
    monkeypatch.setenv("AV_APPROVAL_TOKEN_FILE", str(token))  # the process environment is honoured
    assert mods.ap.agent_token() == ("dotfile-token-value-01", None)


# --------------------------------------------------------------------------
# DATA-311: an explicit publish=false is honoured in every lineage and for
# every source. Nothing marked do-not-publish is proposed, held for approval
# or published, whatever the session or the resident's inferred policy.
# --------------------------------------------------------------------------

PERSONAL = "my health worry"
HELD_SESSIONS = [("cron_job_1", "cron"), ("never-seen", "unknown")]


def _personal(source: str) -> dict:
    return {"text": PERSONAL, "source": source, "publish": False, "reason": "personal"}


def _assert_local(out: dict, reason: str = "personal") -> None:
    assert out["success"] is True and out["published"] is False and out["local_reason"] == reason
    assert out["index_intent_id"] is None
    for key in ("held", "publish_refused", "approval_state", "approved_by"):
        assert key not in out, key


@pytest.mark.parametrize("policy", ["manual", "autonomous"])
@pytest.mark.parametrize("source", ["message", "note", "onboarding"])
@pytest.mark.parametrize("session,lineage", HELD_SESSIONS)
def test_data311_a_personal_capture_in_a_held_session_stays_local(tctx, serve, index, mods, av, plugin,
                                                                  session, lineage, source, policy):
    serve.autonomy[INFERRED] = policy
    assert mods.ri.held_reason(session) == lineage
    out = call(tctx, _personal(source), session=session)
    _assert_local(out)
    # The lineage still decides the source; only the publish decision changed.
    assert out["source"] == "ambient"
    assert serve.calls == [] and index.requests == []
    assert entry(mods, out["intention_id"]) == {"published": False, "source": "ambient", "local_reason": "personal"}
    poll(mods)
    assert serve.calls == [] and index.requests == []
    [event] = events(av, plugin)
    payload = event["payload"]
    assert event["event_type"] == "intention.captured" and payload["source"] == "ambient"
    assert payload["local_reason"] == "personal" and payload["publish_refused"] is None
    assert payload["index_intent_id"] is None
    assert payload.get("approval_state") is None and payload.get("approved_by") is None


@pytest.mark.parametrize("policy", ["manual", "autonomous"])
@pytest.mark.parametrize("session", [SESSION, "cron_job_1", "never-seen"])
def test_data311_an_ambient_capture_marked_publish_false_stays_local(tctx, serve, index, mods, av, plugin,
                                                                     session, policy):
    serve.autonomy[INFERRED] = policy
    out = call(tctx, {**_personal("ambient"), "reason": "participant_asked"}, session=session)
    _assert_local(out, "participant_asked")
    assert out["source"] == "ambient"
    assert serve.calls == [] and index.requests == []
    assert "held_norm_hash" not in entry(mods, out["intention_id"])
    poll(mods)
    assert serve.calls == [] and index.requests == []


@pytest.mark.parametrize("source", ["message", "ambient"])
@pytest.mark.parametrize("session", ["cron_job_1", "never-seen"])
def test_data311_publish_false_still_needs_a_reason_in_a_held_session(tctx, serve, index, mods, av, plugin,
                                                                      session, source):
    out = call(tctx, {"text": PERSONAL, "source": source, "publish": False}, session=session)
    assert out["success"] is False and out["error"] == "reason_required"
    assert serve.calls == [] and index.requests == [] and events(av, plugin) == []
    assert mods.ri._load_map() == {}


def test_data311_the_held_session_event_is_a_normal_local_capture(tctx, serve, index, mods, av, plugin):
    """The same events a local capture in a human session records: one capture,
    no publish attempt, no proposal; only the source differs (the lineage's)."""
    serve.autonomy[INFERRED] = "autonomous"
    call(tctx, _personal("message"))
    call(tctx, _personal("message"), session="cron_job_1", tool_call_id="c2")
    normal, held = events(av, plugin)
    assert normal["event_type"] == held["event_type"] == "intention.captured"
    assert normal["payload"]["source"] == "message" and held["payload"]["source"] == "ambient"
    strip = lambda p: {k: v for k, v in p.items() if k != "source"}  # noqa: E731
    assert strip(normal["payload"]) == strip(held["payload"])
    assert serve.calls == [] and index.requests == []
    # The map tells both apart from a held inferred entry.
    held_ids = [i for i, v in mods.ri._load_map().items() if v.get("local_reason") == "personal"]
    assert len(held_ids) == 2


@pytest.mark.parametrize("policy", ["manual", "autonomous"])
@pytest.mark.parametrize("session", ["cron_job_1", "never-seen"])
def test_data311_a_local_intention_stays_local_through_update_confirm_and_the_poller(
        tctx, serve, index, mods, av, plugin, session, policy):
    serve.autonomy[INFERRED] = policy
    iid = call(tctx, _personal("message"), session=session)["intention_id"]
    for who, n in ((session, "u1"), (SESSION, "u2")):
        out = call(tctx, {"action": "update", "intention_id": iid, "text": PERSONAL + " " + n}, session=who,
                   tool_call_id=n)
        assert out["success"] is True and out["published"] is False and "publish_refused" not in out
        poll(mods)
    for who, n in ((session, "c1"), (SESSION, "c2")):
        out = call(tctx, {"action": "confirm", "intention_id": iid}, session=who, tool_call_id=n)
        assert out["success"] is False and out["error"] == "confirm_not_held"
        poll(mods)
    assert entry(mods, iid) == {"published": False, "source": "ambient", "local_reason": "personal"}
    assert serve.calls == [] and index.requests == []
    # A later stated capture of the same words is not taken for a held one.
    out = call(tctx, {"text": PERSONAL + " u2", "source": "message"}, tool_call_id="s1")
    assert out["published"] is True and "publish_refused" not in out
    out = call(tctx, {"action": "withdraw", "intention_id": iid}, session=session, tool_call_id="w1")
    assert out["success"] is True and out["published"] is False
    assert [c["flags"]["--class"] for c in serve.proposals()] == [STATED_CLASS, STATED_CLASS]


@pytest.mark.parametrize("publish", [None, True, "true"])
@pytest.mark.parametrize("source", ["message", "note", "onboarding"])
@pytest.mark.parametrize("session,lineage", HELD_SESSIONS)
def test_data311_the_lineage_still_downgrades_a_claimed_stated_source(tctx, serve, index, mods, av, plugin,
                                                                      session, lineage, source, publish):
    """The reverse hazard: a held session cannot pass an inferred want off as a
    stated one. Unless publish is false, it is held and proposed as inferred."""
    args: dict[str, Any] = {"text": TEXT, "source": source}
    if publish is not None:
        args["publish"] = publish
    out = call(tctx, args, session=session)
    assert out["source"] == "ambient" and out["publish_refused"] == f"held_{lineage}"
    assert out["held"] is True and out["published"] is False and "local_reason" not in out
    assert [p["flags"]["--class"] for p in serve.proposals()] == [INFERRED]
    assert index.requests == []
    assert "local_reason" not in entry(mods, out["intention_id"])


# --------------------------------------------------------------------------
# DATA-410 refutation 2 (M15): a held marker capture is proposed as inferred
# --------------------------------------------------------------------------


@pytest.mark.parametrize("session,value", [
    ("cron_job_20261012", "yes"), ("cron_job_20261012", "standing"), ("cron_job_20261012", "silence"),
    ("never-seen", "yes"), (SESSION, "silence"),
])
def test_m15_a_held_marker_capture_goes_on_the_card_as_the_agents_words(tctx, serve, index, mods, av, plugin,
                                                                        session, value):
    """Refuter probe M15: with the stated class autonomous (the day-one
    policy), a held capture proposed as stated would publish at once. It is
    proposed under the inferred class, as ambient, and waits for the tap."""
    assert serve.autonomy[STATED_CLASS] == "autonomous" and serve.autonomy[INFERRED] == "manual"
    out = call(tctx, {"text": TEXT, "source": "message", "confirmed_in_chat": value}, session=session)
    assert out["success"] is True and out["published"] is False and out["held"] is True
    assert out["source"] == "ambient" and out["approval_state"] == "requested"
    [p] = serve.proposals()
    assert p["flags"]["--class"] == INFERRED
    assert p["flags"]["--key"] == f"{INFERRED}:{out['intention_id']}"
    assert index.requests == []
    [event] = events(av, plugin)
    assert event["payload"]["source"] == "ambient" and event["payload"]["confirmed_in_chat"] == value
    assert entry(mods, out["intention_id"])["source"] == "ambient"


def test_a_confirmed_yes_from_telegram_is_stated_and_publishes_under_the_stated_policy(tctx, serve, index, av, plugin):
    out = call(tctx, {"text": STATED, "source": "message", "confirmed_in_chat": "yes"})
    assert out["published"] is True and out["source"] == "message" and out["confirmed_in_chat"] == "yes"
    assert {p["flags"].get("--class") for p in serve.proposals()} == {STATED_CLASS}
    assert events(av, plugin)[0]["payload"]["confirmed_in_chat"] == "yes"

