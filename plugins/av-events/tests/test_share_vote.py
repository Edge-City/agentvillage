"""Lane O3: `share_digest` and `village_vote` through the resident's approval.md.

The daemon is faked in-process (`FakeServe`, the shape of Lane B's fake in
`test_intent_approval.py`: `approval serve`'s `POST /verb/<name>` for
`propose`, `wait --timeout 0`, `start` and `withdraw`), with core's payload
hash taken over the RFC 8785 form, as core and the door take it. The weekly
question comes from a fake provider. The contract (the closed schemas' field
lists, the approval link's known-answer vectors and the text rule's cases)
is `vectors/share_vote_contract.json`, a copy of the data repo's. No test
reaches the network.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

CONTRACT = json.loads((Path(__file__).parent / "vectors" / "share_vote_contract.json").read_text(encoding="utf-8"))
SHARE_V = CONTRACT["vectors"]["share"]
VOTE_V = CONTRACT["vectors"]["vote"]

TOKEN = "agent-token-for-the-lane-o3-tests-00001"
FACADE = "https://approval.example"
ACTOR = "agent:test"
SESSION = "sess-o3"
TENANT = VOTE_V["tenant_id"]
TEXT = "Looking for a Rust reviewer for my side project this week"
TEXT_WORDS = ("Rust", "reviewer", "side project")
QUESTION_ID = VOTE_V["question_id"]
SHARE = "digest.share"
VOTE = "village.vote"
NOW = 1_790_000_000.0  # 2026-09-21, a fixed clock
DAY = 86400.0


def jcs(payload_json: str) -> str:
    return json.dumps(json.loads(payload_json), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def task_id(cls: str, key: str) -> str:
    return "propose:" + sha(json.dumps([ACTOR, cls, key], separators=(",", ":")))[:32]


class FakeServe:
    """`approval serve`'s agent surface, as Lane B's fake answers it."""

    def __init__(self) -> None:
        self.autonomy = {SHARE: "manual", VOTE: "manual"}
        self.requestable = {SHARE, VOTE}
        self.tasks: dict[str, dict] = {}
        self.calls: list[dict] = []
        self.down = False
        self.seq = 40
        self.start_answer: Optional[tuple] = None
        self.on_wait: Optional[Callable[[int], Optional[tuple]]] = None
        self.waits = 0

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
        for t in self.tasks.values():
            if t["state"] in ("requested", "granted") and not t["executed"]:
                t["state"] = "void"

    def proposals(self) -> list[dict]:
        return [c for c in self.calls if c["verb"] == "propose"]

    def verbs(self) -> list[str]:
        return [c["verb"] for c in self.calls]

    def transport(self, endpoint, path, body, headers):  # noqa: ANN001
        if self.down:
            raise ConnectionRefusedError()
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        verb = path.rsplit("/", 1)[-1]
        args = json.loads(body.decode("utf-8"))
        flags, positionals = args.get("flags", {}), args.get("positionals", [])
        self.calls.append({"verb": verb, "flags": flags, "positionals": positionals})
        code, out, err = getattr(self, "_" + verb)(positionals, flags)
        answer = {"exit_code": code, "stdout": json.dumps(out) + "\n" if out else "",
                  "stderr": json.dumps(err) + "\n" if err else "", "stdout_truncated": False, "stderr_truncated": False}
        return 200, json.dumps(answer).encode()

    @staticmethod
    def _error(code: str, exit_code: int = 1) -> tuple:
        return exit_code, None, {"ok": False, "error": {"code": code, "message": "x"}}

    def _next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def _propose(self, _pos, flags):
        cls, key, payload = flags["--class"], flags["--key"], flags["--payload-json"]
        assert flags["--json"] is True and isinstance(flags["--summary"], str)
        if not key.startswith(cls + ":"):
            return self._error("key-class-mismatch", 2)
        if cls not in self.requestable:
            return self._error("class-not-agent-requestable")
        task = task_id(cls, key)
        phash = sha(jcs(payload))
        manual = self.autonomy.get(cls) == "manual"
        t = self.tasks.get(task)
        if t is not None and t["hash"] != phash:
            return self._error("payload-mismatch")
        base = {"ok": True, "task": task, "action_key": key, "class": cls, "payload_hash": phash}
        if t is None:
            t = {"key": key, "class": cls, "hash": phash, "executed": False,
                 "state": "requested" if manual else "none", "asks": 1 if manual else 0}
            self.tasks[task] = t
            if manual:
                return 0, {**base, "decision": "requested", "state": "requested", "seq": self._next_seq(),
                           "idempotent": False}, None
            return 0, {**base, "decision": "autonomous", "state": None, "seq": None, "idempotent": False}, None
        if t["executed"]:
            return 0, {**base, "decision": "requested" if manual else "autonomous", "state": "executed", "seq": 5,
                       "idempotent": True}, None
        if t["state"] in ("expired", "void", "withdrawn"):
            t["state"] = "requested" if manual else "none"
            t["asks"] += 1
            return 0, {**base, "decision": "requested" if manual else "autonomous",
                       "state": "requested" if manual else None, "seq": self._next_seq(), "idempotent": False}, None
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
        t = self.tasks.get(pos[0])
        if t is None:
            return self._error("not-registered")
        doc = {"task": pos[0], "actions": []}
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
        t = self.tasks.get(pos[0])
        if t is None:
            return self._error("not-registered")
        assert flags["--action"] == t["key"]
        if sha(jcs(flags["--payload-json"])) != t["hash"]:
            return self._error("payload-mismatch")
        manual = self.autonomy.get(t["class"]) == "manual"
        if t["executed"]:
            return self._error("not-granted" if manual else "already-executed")
        if t["state"] == "void":
            return self._error("policy-drift")
        if t["state"] == "granted":
            t["executed"] = True
            return 0, {"ok": True, "task": pos[0], "action_key": t["key"], "class": t["class"],
                       "authorization": "grant", "seq": self._next_seq()}, None
        if t["state"] == "none" and not manual:
            t["executed"] = True
            return 0, {"ok": True, "task": pos[0], "action_key": t["key"], "class": t["class"],
                       "authorization": "policy", "seq": self._next_seq()}, None
        return self._error("not-granted")

    def _withdraw(self, pos, flags):
        t = self.tasks.get(pos[0])
        if t is None or t["state"] != "requested":
            return self._error("not-pending")
        t["state"] = "withdrawn"
        return 0, {"ok": True}, None


class Ctx:
    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.tools: dict[str, dict] = {}

    def register_hook(self, hook_name, callback):  # noqa: ANN001
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                      is_async=False, description="", emoji="", override=False):  # noqa: ANN001
        self.tools[name] = {"handler": handler, "description": description, "schema": schema, "toolset": toolset}
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
        "sv": sys.modules[f"{name}._share_vote"],
        "vq": sys.modules[f"{name}._village_question"],
        "ap": sys.modules[f"{name}._approval"],
    })


@pytest.fixture()
def clock(mods, monkeypatch):
    now = {"t": NOW}
    monkeypatch.setattr(mods.sv, "_clock", lambda: now["t"])
    return now


@pytest.fixture()
def serve(mods, monkeypatch):
    fake = FakeServe()
    monkeypatch.setattr(mods.ap, "_transport", fake.transport)
    return fake


@pytest.fixture()
def kicks(mods, monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(mods.ap, "ensure_poller", lambda: seen.append("thread") or True)
    monkeypatch.setattr(mods.ap, "kick", lambda: seen.append("kick"))
    monkeypatch.setattr(mods.ap, "_PASSES", {})
    return seen


class Q:
    """The fake provider's question; `closes_at` moves with the test."""

    def __init__(self, mods) -> None:
        self.mods = mods
        self.closes_at = NOW + 3 * DAY
        self.question_id = QUESTION_ID
        self.options = ("yes", "no", "abstain")

    def __call__(self):
        return self.mods.vq.Question(self.question_id, "Should the village keep quiet hours after 22:00?",
                                     self.options, self.closes_at, opens_at=NOW - DAY)


@pytest.fixture()
def question(mods):
    q = Q(mods)
    mods.vq.set_provider(q)
    yield q
    mods.vq.set_provider(None)


@pytest.fixture()
def env(monkeypatch, home):
    for name in ("AV_DIGEST_SHARE", "AV_VILLAGE_VOTE", "AV_RECORD_INTENTION"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "1")
    monkeypatch.setenv("AV_APPROVAL_URL", FACADE)
    monkeypatch.setenv("AV_APPROVAL_TOKEN", TOKEN)
    monkeypatch.setenv("AV_DIGEST_SHARE", "1")
    monkeypatch.setenv("AV_VILLAGE_VOTE", "1")
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")


@pytest.fixture()
def tctx(plugin, env, serve, kicks, clock, question):
    ctx = Ctx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return ctx


def call(ctx: Ctx, tool: str, args: dict) -> dict:
    return json.loads(ctx.tools[tool]["handler"](args, task_id="task-1", session_id=SESSION))


def share(ctx: Ctx, **args: Any) -> dict:
    return call(ctx, "share_digest", {"action": "share", "text": TEXT, **args})


def vote(ctx: Ctx, **args: Any) -> dict:
    return call(ctx, "village_vote", {"action": "vote", "question_id": QUESTION_ID, "answer": "yes", **args})


def poll(mods, execute: bool = True) -> None:
    mods.sv.run_share_vote_pass(execute)


def ours(av, plugin) -> list[dict]:
    return [e for e in av.read_buffer(plugin._COLLECTOR)
            if e["event_type"] in ("digest.shared", "digest.revoked", "vote.cast")]


def entry(mods, key: str) -> dict:
    return mods.sv._load_map()[key]


def instant(value: str) -> float:
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", value), value
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def conforms(event_type: str, payload: dict) -> None:
    """The payload against the copied closed schema: exactly its keys, every
    value shaped, the link consistent with the payload (the door's check)."""
    schema = CONTRACT["schemas"][f"{event_type}@1"]
    pat = CONTRACT["patterns"]
    keys = set(payload)
    assert set(schema["required"]) <= keys, keys
    assert keys <= set(schema["required"]) | set(schema["optional"]), keys
    if "digest_id" in payload:
        assert re.fullmatch(pat["digest_id"], payload["digest_id"]) and payload["digest_id"] not in pat["reserved_ids"]
    if event_type == "digest.revoked":
        return
    for name in ("idempotency_key", "payload_hash"):
        assert re.fullmatch(pat["link_digest"], payload[name]) and payload[name] not in pat["reserved_digests"]
    assert type(payload["start_seq"]) is int and 1 <= payload["start_seq"] <= pat["start_seq_max"]
    assert payload["authorization"] in schema["authorization"]
    if event_type == "digest.shared":
        assert re.fullmatch(pat["scope"], payload["scope"])
        assert len(payload["text"]) <= pat["text_max_code_points"]
        instant(payload["expires_at"])
        assert payload["idempotency_key"] == sha(f"digest.share:{payload['digest_id']}")
        proposed = {k: payload[k] for k in ("digest_id", "scope", "text", "expires_at")}
    else:
        assert re.fullmatch(pat["question_id"], payload["question_id"]) and ":" not in payload["question_id"]
        assert re.fullmatch(pat["answer"], payload["answer"])
        assert payload["idempotency_key"] == sha(f"village.vote:{payload['question_id']}:{TENANT}")
        proposed = {k: payload[k] for k in ("question_id", "answer")}
    assert payload["payload_hash"] == sha(json.dumps(proposed, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


# --------------------------------------------------------------------------
# The contract's known answers
# --------------------------------------------------------------------------


def test_the_known_answer_vectors(mods):
    sv = mods.sv
    payload = sv.share_payload(SHARE_V["digest_id"], SHARE_V["scope"], SHARE_V["text"], SHARE_V["expires_at"])
    assert sv.share_key(SHARE_V["digest_id"]) == SHARE_V["action_key"]
    assert sv.sha256_hex(SHARE_V["action_key"]) == SHARE_V["idempotency_key"]
    assert sv.sha256_hex(payload) == SHARE_V["payload_hash"]
    event = sv.shared_event_payload(payload, SHARE_V["payload_hash"], 42, "grant")
    assert event["idempotency_key"] == SHARE_V["idempotency_key"] and event["payload_hash"] == SHARE_V["payload_hash"]
    conforms("digest.shared", event)

    payload = sv.vote_payload(VOTE_V["question_id"], VOTE_V["answer"])
    assert payload == VOTE_V["canonical_payload"]
    assert sv.vote_key(VOTE_V["question_id"], VOTE_V["tenant_id"]) == VOTE_V["action_key"]
    assert sv.sha256_hex(payload) == VOTE_V["payload_hash"]
    event = sv.vote_event_payload(payload, VOTE_V["tenant_id"], VOTE_V["payload_hash"], 7, "grant")
    assert event["idempotency_key"] == VOTE_V["idempotency_key"]
    conforms("vote.cast", event)
    conforms("vote.cast", sv.vote_event_payload(payload, VOTE_V["tenant_id"], VOTE_V["payload_hash"], 7, "policy"))
    conforms("digest.revoked", sv.revoked_event_payload(SHARE_V["digest_id"]))


def test_the_classes_and_bounds_are_the_contract_s(mods):
    sv = mods.sv
    assert {sv.SHARED_EVENT: sv.SHARE_CLASS, sv.VOTE_EVENT: sv.VOTE_CLASS} == CONTRACT["classes"]
    assert sv.DIGEST_MAX_TTL_S * 1000 == CONTRACT["digest_max_ttl_ms"]
    assert sv.MAX_TTL_S < sv.DIGEST_MAX_TTL_S and sv.DIGEST_TEXT_MAX == CONTRACT["patterns"]["text_max_code_points"]
    assert sv.SCOPE.pattern == CONTRACT["patterns"]["scope"]
    assert mods.vq.QUESTION_ID.pattern == CONTRACT["patterns"]["question_id"]
    assert mods.vq.OPTION_KEY.pattern == CONTRACT["patterns"]["answer"]


def test_the_text_rule_class_by_class(mods):
    problem = mods.sv.digest_text_problem
    for text in CONTRACT["text_rule"]["admitted"] + ["x" * 500]:
        assert problem(text) is None, ascii(text)
    refused = {**CONTRACT["text_rule"]["refused"], **CONTRACT["text_rule"]["refused_lone_surrogates"],
               "over the cap": "x" * 501}
    for name, text in refused.items():
        assert problem(text) is not None, name


# --------------------------------------------------------------------------
# Switched off: nothing registered, nothing sent
# --------------------------------------------------------------------------


@pytest.mark.parametrize("share_flag,vote_flag,expected", [
    (None, None, set()), ("1", None, {"share_digest"}), (None, "on", {"village_vote"}), ("0", "no", set()),
])
def test_each_tool_is_registered_only_behind_its_switch(plugin, env, serve, kicks, monkeypatch, share_flag, vote_flag,
                                                       expected):
    for name, value in (("AV_DIGEST_SHARE", share_flag), ("AV_VILLAGE_VOTE", vote_flag)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    ctx = Ctx()
    plugin.register(ctx)
    assert set(ctx.tools) & {"share_digest", "village_vote"} == expected
    if not expected:
        assert kicks == [] and serve.calls == []


def test_a_switch_in_the_dotenv_file_does_not_turn_it_on(plugin, env, serve, kicks, home, monkeypatch):
    monkeypatch.delenv("AV_DIGEST_SHARE")
    monkeypatch.delenv("AV_VILLAGE_VOTE")
    (home / ".env").write_text("AV_DIGEST_SHARE=1\nAV_VILLAGE_VOTE=1\n", encoding="utf-8")
    ctx = Ctx()
    plugin.register(ctx)
    assert "share_digest" not in ctx.tools and "village_vote" not in ctx.tools


def test_switched_off_after_a_proposal_nothing_is_asked_or_sent(tctx, serve, mods, av, plugin, monkeypatch):
    out = share(tctx)
    serve.grant(f"digest.share:{out['digest_id']}")
    calls = len(serve.calls)
    monkeypatch.delenv("AV_DIGEST_SHARE")
    poll(mods)
    assert len(serve.calls) == calls and ours(av, plugin) == []
    assert call(tctx, "share_digest", {"action": "share", "text": TEXT})["error"] == "disabled"


def test_without_approval_the_tools_refuse_and_nothing_is_proposed(tctx, serve, monkeypatch):
    monkeypatch.delenv("AV_APPROVAL_URL")
    assert share(tctx)["error"] == "approval_not_configured"
    assert vote(tctx)["error"] == "approval_not_configured"
    assert serve.calls == []


# --------------------------------------------------------------------------
# digest.share
# --------------------------------------------------------------------------


def test_a_share_proposes_exactly_the_contract_object_and_no_text_in_the_summary(tctx, serve, mods, av, plugin):
    out = share(tctx, scope="service:coordination", expires_in_hours=48)
    assert out["success"] is True and out["state"] == "requested"
    digest_id = out["digest_id"]
    assert re.fullmatch(CONTRACT["patterns"]["digest_id"], digest_id)
    assert instant(out["expires_at"]) == pytest.approx(NOW + 48 * 3600, abs=0.001)
    [p] = serve.proposals()
    assert p["flags"]["--class"] == SHARE and p["flags"]["--key"] == f"digest.share:{digest_id}"
    payload = p["flags"]["--payload-json"]
    assert json.loads(payload) == {"digest_id": digest_id, "scope": "service:coordination", "text": TEXT,
                                   "expires_at": out["expires_at"]}
    assert payload == jcs(payload)  # its own RFC 8785 form: the plain hash is core's
    summary = p["flags"]["--summary"]
    assert digest_id in summary and not any(word in summary for word in TEXT_WORDS)
    assert TEXT not in json.dumps(out)
    assert ours(av, plugin) == []


def test_a_grant_starts_with_the_same_bytes_and_emits_one_digest_shared(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    poll(mods)  # pending: one wait, nothing else
    assert serve.verbs() == ["propose", "wait"] and ours(av, plugin) == []
    serve.grant(key)
    poll(mods)
    proposed = serve.proposals()[0]["flags"]["--payload-json"]
    [started] = [c for c in serve.calls if c["verb"] == "start"]
    assert started["flags"]["--payload-json"] == proposed and started["flags"]["--action"] == key
    [event] = ours(av, plugin)
    assert event["event_type"] == "digest.shared" and event["schema_version"] == 1
    assert event["actor"] == "agent" and event["session_id"] is None and event["decision_id"] is None
    assert event["evidence_class"] == "agent_report"
    p = event["payload"]
    conforms("digest.shared", p)
    assert p["text"] == TEXT and p["scope"] == "village" and p["authorization"] == "grant"
    assert p["idempotency_key"] == sha(key) and p["payload_hash"] == sha(proposed)
    assert p["start_seq"] == serve.seq  # the seq start answered with
    assert "decision_id" not in p and "policy_version" not in p
    # Expiry: after the event, at most 7 days less an hour after it.
    expires = instant(p["expires_at"])
    assert NOW < expires <= NOW + 7 * DAY - 3600
    assert instant(event["occurred_at"]) < expires
    e = entry(mods, key)
    assert e["state"] == "emitted" and "payload" not in e and e["event_id"] == event["event_id"]
    # Later passes, and a second look, do nothing more.
    poll(mods)
    poll(mods)
    assert len(ours(av, plugin)) == 1 and serve.verbs().count("start") == 1


def test_the_held_text_is_in_a_0600_map_only_until_the_proposal_ends(tctx, serve, mods):
    out = share(tctx)
    path = Path(mods.sv.map_path())
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert TEXT in path.read_text(encoding="utf-8")
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods)
    raw = path.read_text(encoding="utf-8")
    assert TEXT not in raw and out["digest_id"] in raw


@pytest.mark.parametrize("ending,final", [("reject", "rejected"), ("expire", "expired")])
def test_a_declined_or_expired_share_emits_nothing_and_drops_the_text(tctx, serve, mods, av, plugin, ending, final):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    getattr(serve, ending)(key)
    poll(mods)
    e = entry(mods, key)
    assert e["state"] == final and "payload" not in e
    assert "start" not in serve.verbs() and ours(av, plugin) == []
    poll(mods)
    assert serve.verbs().count("wait") == 1  # final: never asked again
    assert len(serve.proposals()) == 1


def test_a_void_grant_is_never_spent_the_same_bytes_are_asked_again(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    serve.reattest()
    poll(mods)
    assert "start" not in serve.verbs() and ours(av, plugin) == []
    assert len(serve.proposals()) == 2
    assert serve.proposals()[1]["flags"]["--payload-json"] == serve.proposals()[0]["flags"]["--payload-json"]
    serve.grant(key)
    poll(mods)
    assert len(ours(av, plugin)) == 1


def test_policy_drift_at_start_emits_nothing(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    serve.start_answer = FakeServe._error("policy-drift")
    poll(mods)
    assert ours(av, plugin) == [] and entry(mods, key)["state"] in ("unfiled", "requested")


def test_a_daemon_that_is_down_means_no_event_until_a_grant_is_read(tctx, serve, mods, av, plugin):
    serve.down = True
    out = share(tctx)
    assert out["success"] is True and out["state"] == "unfiled"
    key = f"digest.share:{out['digest_id']}"
    poll(mods)
    assert entry(mods, key)["state"] == "unfiled" and ours(av, plugin) == []
    serve.down = False
    poll(mods)
    assert entry(mods, key)["state"] == "requested"
    serve.grant(key)
    serve.down = True
    poll(mods)
    assert ours(av, plugin) == [] and entry(mods, key)["state"] == "requested"
    serve.down = False
    poll(mods)
    assert len(ours(av, plugin)) == 1


def test_the_daemon_failing_between_the_re_read_and_start_emits_nothing(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    real = serve._start

    def lost(pos, flags):
        real(pos, flags)  # the start lands, its answer is lost
        raise ConnectionResetError()

    serve._start = lost  # type: ignore[method-assign]
    poll(mods)
    assert ours(av, plugin) == []
    e = entry(mods, key)
    assert e["state"] == "requested" and e["code"] == "transport"
    serve._start = real  # type: ignore[method-assign]
    poll(mods)  # the spent grant reads nothing-to-wait-for: never emitted
    assert entry(mods, key)["state"] == "start_unconfirmed" and ours(av, plugin) == []


def test_a_share_the_policy_clears_is_never_started(tctx, serve, mods, av, plugin):
    serve.autonomy[SHARE] = "autonomous"
    out = share(tctx)
    assert out["state"] == "not_shared" and out["code"] == "share_needs_grant"
    assert "start" not in serve.verbs() and ours(av, plugin) == []
    assert "payload" not in entry(mods, f"digest.share:{out['digest_id']}")


def test_a_share_class_the_policy_does_not_offer_is_refused(tctx, serve, mods, av, plugin):
    serve.requestable.discard(SHARE)
    out = share(tctx)
    assert out["state"] == "refused" and out["code"] == "class-not-agent-requestable"
    assert ours(av, plugin) == [] and "payload" not in entry(mods, f"digest.share:{out['digest_id']}")


def test_no_event_while_nothing_could_carry_it(tctx, serve, mods, av, plugin, monkeypatch):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    monkeypatch.setattr(plugin._COLLECTOR, "plugin_disabled", True)
    poll(mods)
    assert "start" not in serve.verbs() and entry(mods, key)["code"] == "emitter_inactive"
    monkeypatch.setattr(plugin._COLLECTOR, "plugin_disabled", False)
    poll(mods)
    assert len(ours(av, plugin)) == 1


def test_an_event_nothing_could_carry_after_its_start_is_never_sent_later(tctx, serve, mods, av, plugin, monkeypatch):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    emit = mods.sv._emit_fn
    monkeypatch.setattr(mods.sv, "_emit_fn", lambda *a, **k: False)
    poll(mods)
    e = entry(mods, key)
    assert e["state"] == "emit_failed" and "payload" not in e and ours(av, plugin) == []
    monkeypatch.setattr(mods.sv, "_emit_fn", emit)
    poll(mods)
    assert ours(av, plugin) == [] and serve.verbs().count("start") == 1


def test_a_call_that_died_after_buffering_is_never_sent_again(tctx, serve, mods, av, plugin, monkeypatch, clock):
    """The map write after the buffer append is lost: the entry stays
    `emitting`, and the pass never sends from it."""
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    real_set = mods.sv._set

    def crash(entry_id, expect, state, **kw):
        if state == "emitted":
            raise SystemExit("crash")
        return real_set(entry_id, expect, state, **kw)

    monkeypatch.setattr(mods.sv, "_set", crash)
    with pytest.raises(SystemExit):
        poll(mods)
    monkeypatch.setattr(mods.sv, "_set", real_set)
    assert entry(mods, key)["state"] == "emitting" and len(ours(av, plugin)) == 1
    poll(mods)  # fresh: the call may still be in flight; left alone
    assert entry(mods, key)["state"] == "emitting"
    clock["t"] = NOW + mods.sv.STALE_EMITTING_S + 1
    poll(mods)
    assert entry(mods, key)["state"] == "emit_unconfirmed" and len(ours(av, plugin)) == 1
    assert serve.verbs().count("start") == 1


def test_a_reloaded_plugin_never_emits_a_share_again(tctx, serve, mods, av, plugin, kicks):
    out = share(tctx)
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods)
    assert len(ours(av, plugin)) == 1
    av.load_plugin()  # a new process: the same map and buffer on disk
    fresh_sv = sys.modules[f"{av.MODULE_NAME}._share_vote"]
    sys.modules[f"{av.MODULE_NAME}._approval"]._transport = serve.transport
    fresh_sv.set_emitter(mods.sv._emit_fn, mods.sv._ready_fn)
    fresh_sv.run_share_vote_pass()
    assert len(ours(av, plugin)) == 1 and serve.verbs().count("start") == 1


def test_a_one_shot_resume_pass_never_starts(tctx, serve, mods, av, plugin):
    out = share(tctx)
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods, execute=False)
    assert "start" not in serve.verbs() and ours(av, plugin) == []


def test_an_abandoned_claim_is_released_and_the_daemon_asked_again(tctx, serve, mods, av, plugin, clock):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    mods.sv._cas(key, None, lambda e: e.update(state="starting", claim="c1", claimed_at=NOW, back="requested"))
    poll(mods)
    assert entry(mods, key)["state"] == "starting"  # fresh: left alone
    clock["t"] = NOW + mods.sv.STALE_STARTING_S + 1
    poll(mods)
    assert entry(mods, key)["state"] == "requested"


# ---- The expiry bound ------------------------------------------------------


@pytest.mark.parametrize("hours,expected", [(None, 7 * DAY - 3600), (167, 7 * DAY - 3600), (1, 3600), (24, DAY)])
def test_the_share_expiry_stays_inside_the_door_s_seven_days(tctx, mods, hours, expected):
    args = {} if hours is None else {"expires_in_hours": hours}
    out = share(tctx, **args)
    assert instant(out["expires_at"]) == pytest.approx(NOW + expected, abs=0.001)
    assert instant(out["expires_at"]) - NOW <= CONTRACT["digest_max_ttl_ms"] / 1000 - 3600


@pytest.mark.parametrize("bad", [0, 168, -1, 1.5, True, "a week"])
def test_an_expiry_out_of_range_is_refused(tctx, serve, bad):
    assert share(tctx, expires_in_hours=bad)["error"] == "expires_invalid" and serve.calls == []


def test_a_grant_that_comes_too_late_for_the_expiry_is_not_started(tctx, serve, mods, av, plugin, clock):
    out = share(tctx, expires_in_hours=1)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    clock["t"] = NOW + 3600 - mods.sv.MIN_REMAINING_S + 1
    poll(mods)
    e = entry(mods, key)
    assert e["state"] == "lapsed" and e["code"] == "share_expired" and "payload" not in e
    assert "start" not in serve.verbs() and ours(av, plugin) == []


def test_a_pending_share_past_its_expiry_is_withdrawn_on_the_daemon(tctx, serve, mods, clock):
    out = share(tctx, expires_in_hours=1)
    key = f"digest.share:{out['digest_id']}"
    clock["t"] = NOW + 3600
    poll(mods)
    assert entry(mods, key)["state"] == "lapsed" and serve.verbs()[-1] == "withdraw"
    assert serve.tasks[task_id(SHARE, key)]["state"] == "withdrawn"


def test_a_map_expiry_moved_past_seven_days_is_refused(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)

    def stretch(e):
        e["expires_at"] = "2027-01-01T00:00:00.000Z"

    mods.sv._cas(key, None, stretch)
    poll(mods)
    assert entry(mods, key)["state"] == "invalid" and ours(av, plugin) == []


# ---- Refusals at the tool ----------------------------------------------------


@pytest.mark.parametrize("text,code", [
    ("", "text_required"), (None, "text_required"), ("x" * 501, "text_too_long"), ("a\u202eb", "text_invalid"),
    ("?!", "text_no_letter_or_digit"), ("use Bearer abcdefghijklmnop to log in", "text_sanitized"),
    ("key sk-or-v1-abcdefghijklmnopqrstuvwxyz", "text_sanitized"),
])
def test_text_the_door_or_the_sanitiser_would_change_is_refused(tctx, serve, text, code):
    assert call(tctx, "share_digest", {"action": "share", "text": text})["error"] == code
    assert serve.calls == []


@pytest.mark.parametrize("scope", ["Village", "service:", "service:Odin", "everyone", "service:a b"])
def test_a_scope_outside_the_contract_is_refused(tctx, serve, scope):
    assert share(tctx, scope=scope)["error"] == "scope_invalid" and serve.calls == []


def test_open_share_proposals_are_capped(tctx, serve):
    for _ in range(5):
        assert share(tctx)["state"] == "requested"
    assert share(tctx)["error"] == "too_many_pending" and len(serve.proposals()) == 5


# ---- Revocation ---------------------------------------------------------------


def test_revoking_a_shared_digest_emits_one_digest_revoked(tctx, serve, mods, av, plugin):
    out = share(tctx)
    digest_id = out["digest_id"]
    serve.grant(f"digest.share:{digest_id}")
    poll(mods)
    calls = len(serve.calls)
    rev = call(tctx, "share_digest", {"action": "revoke", "digest_id": digest_id})
    assert rev["success"] is True and rev["state"] == "revoked"
    shared, revoked = ours(av, plugin)
    assert revoked["event_type"] == "digest.revoked" and revoked["payload"] == {"digest_id": digest_id}
    conforms("digest.revoked", revoked["payload"])
    assert revoked["actor"] == "agent" and revoked["decision_id"] is None
    assert len(serve.calls) == calls  # no approval for a revocation
    again = call(tctx, "share_digest", {"action": "revoke", "digest_id": digest_id})
    assert again["state"] == "revoked" and len(ours(av, plugin)) == 2
    poll(mods)
    assert len(ours(av, plugin)) == 2


def test_revoking_a_pending_share_withdraws_the_question_and_emits_nothing(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    rev = call(tctx, "share_digest", {"action": "revoke", "digest_id": out["digest_id"]})
    assert rev["state"] == "withdrawn" and rev["shared"] is False
    assert serve.tasks[task_id(SHARE, key)]["state"] == "withdrawn" and ours(av, plugin) == []
    assert "payload" not in entry(mods, key)
    poll(mods)
    assert ours(av, plugin) == []


def test_revoking_after_the_share_lapsed_sends_nothing(tctx, serve, mods, av, plugin, clock):
    out = share(tctx, expires_in_hours=2)
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods)
    clock["t"] = NOW + 2 * 3600 + 1
    rev = call(tctx, "share_digest", {"action": "revoke", "digest_id": out["digest_id"]})
    assert rev["state"] == "revoke_lapsed" and len(ours(av, plugin)) == 1


def test_a_revocation_that_could_not_be_buffered_is_refused_and_can_be_asked_again(tctx, serve, mods, av, plugin,
                                                                                    monkeypatch):
    out = share(tctx)
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods)
    emit = mods.sv._emit_fn
    monkeypatch.setattr(mods.sv, "_emit_fn", lambda *a, **k: False)
    rev = call(tctx, "share_digest", {"action": "revoke", "digest_id": out["digest_id"]})
    assert rev["error"] == "revoke_failed"
    assert entry(mods, f"digest.share:{out['digest_id']}")["state"] == "emitted"
    monkeypatch.setattr(mods.sv, "_emit_fn", emit)
    poll(mods)
    assert [e["event_type"] for e in ours(av, plugin)] == ["digest.shared"]
    assert call(tctx, "share_digest", {"action": "revoke", "digest_id": out["digest_id"]})["state"] == "revoked"
    assert [e["event_type"] for e in ours(av, plugin)] == ["digest.shared", "digest.revoked"]


def test_revoke_works_without_approval_and_refuses_an_unknown_digest(tctx, serve, mods, av, plugin, monkeypatch):
    out = share(tctx)
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods)
    monkeypatch.delenv("AV_APPROVAL_URL")
    assert call(tctx, "share_digest", {"action": "revoke", "digest_id": out["digest_id"]})["state"] == "revoked"
    assert call(tctx, "share_digest", {"action": "revoke", "digest_id": SHARE_V["digest_id"]})["error"] == "digest_unknown"
    assert call(tctx, "share_digest", {"action": "revoke"})["error"] == "digest_id_required"


# --------------------------------------------------------------------------
# village.vote
# --------------------------------------------------------------------------


def test_without_a_question_source_the_vote_tool_refuses_with_a_code(plugin, env, serve, kicks, clock, mods):
    mods.vq.set_provider(None)  # the shipped provider: not yet available
    ctx = Ctx()
    plugin.register(ctx)
    q = call(ctx, "village_vote", {"action": "question"})
    assert q["success"] is False and q["error"] == "question_unavailable" and q["reason"] == "question_source_not_built"
    v = vote(ctx)
    assert v["error"] == "question_unavailable" and v["reason"] == "question_source_not_built"
    assert serve.calls == []


def test_the_question_is_read_through_the_provider(tctx):
    q = call(tctx, "village_vote", {"action": "question"})
    assert q["question_id"] == QUESTION_ID and q["options"] == ["yes", "no", "abstain"]
    assert instant(q["closes_at"]) == pytest.approx(NOW + 3 * DAY, abs=0.001)


def test_a_vote_proposes_question_and_answer_only_and_the_grant_emits_vote_cast(tctx, serve, mods, av, plugin):
    out = vote(tctx, rationale="They said at dinner they sleep early")
    assert out["success"] is True and out["state"] == "requested"
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    [p] = serve.proposals()
    assert p["flags"]["--class"] == VOTE and p["flags"]["--key"] == key
    assert p["flags"]["--payload-json"] == VOTE_V["canonical_payload"]
    # The rationale goes in the summary, never the payload.
    assert "sleep early" in p["flags"]["--summary"] and "sleep" not in p["flags"]["--payload-json"]
    serve.grant(key)
    poll(mods)
    [event] = ours(av, plugin)
    assert event["event_type"] == "vote.cast" and event["actor"] == "agent" and event["session_id"] is None
    conforms("vote.cast", event["payload"])
    assert event["payload"] == {"question_id": QUESTION_ID, "answer": "yes", "idempotency_key": VOTE_V["idempotency_key"],
                                "payload_hash": VOTE_V["payload_hash"], "start_seq": serve.seq,
                                "authorization": "grant"}
    assert "sleep" not in json.dumps(entry(mods, key))  # the rationale goes with the proposal
    poll(mods)
    assert len(ours(av, plugin)) == 1


def test_a_vote_the_policy_clears_is_cast_in_the_tool_call_as_policy(tctx, serve, mods, av, plugin):
    serve.autonomy[VOTE] = "autonomous"
    out = vote(tctx)
    assert out["state"] == "emitted"
    [event] = ours(av, plugin)
    assert event["payload"]["authorization"] == "policy"
    conforms("vote.cast", event["payload"])
    assert serve.verbs() == ["propose", "propose", "start"]


def test_the_poller_never_casts_a_vote_the_policy_clears(tctx, serve, mods, av, plugin):
    serve.autonomy[VOTE] = "autonomous"
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    mods.sv._open(key, {"class": VOTE, "key": key, "question_id": QUESTION_ID, "answer": "yes",
                        "closes_at": NOW + DAY, "payload": VOTE_V["canonical_payload"]}, inline=False)
    poll(mods)
    assert entry(mods, key)["state"] == "not_cast" and "start" not in serve.verbs() and ours(av, plugin) == []


@pytest.mark.parametrize("ending,final", [("reject", "rejected"), ("expire", "expired")])
def test_a_declined_or_expired_vote_emits_nothing(tctx, serve, mods, av, plugin, ending, final):
    vote(tctx)
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    getattr(serve, ending)(key)
    poll(mods)
    assert entry(mods, key)["state"] == final and ours(av, plugin) == [] and "start" not in serve.verbs()


def test_a_void_vote_grant_is_asked_again_and_a_down_daemon_casts_nothing(tctx, serve, mods, av, plugin):
    vote(tctx)
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    serve.grant(key)
    serve.reattest()
    poll(mods)
    assert ours(av, plugin) == [] and len(serve.proposals()) == 2
    serve.grant(key)
    serve.down = True
    poll(mods)
    assert ours(av, plugin) == []
    serve.down = False
    poll(mods)
    assert len(ours(av, plugin)) == 1


def test_a_down_daemon_at_vote_time_files_it_later(tctx, serve, mods, av, plugin):
    serve.down = True
    assert vote(tctx)["state"] == "unfiled"
    serve.down = False
    poll(mods)
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    assert entry(mods, key)["state"] == "requested" and ours(av, plugin) == []


def test_a_question_takes_one_answer(tctx, serve, mods):
    assert vote(tctx)["state"] == "requested"
    again = vote(tctx, answer="no")
    assert again["error"] == "vote_already_proposed" and again["answer"] == "yes"
    same = vote(tctx)
    assert same["success"] is True and same["state"] == "requested"
    assert len(serve.proposals()) == 1


@pytest.mark.parametrize("args,code", [
    ({"answer": "maybe"}, "answer_invalid"), ({"answer": "yes please"}, "answer_invalid"),
    ({"question_id": "q-2026-w41"}, "question_not_open"), ({"question_id": ""}, "question_id_required"),
    ({"rationale": "x" * 281}, "rationale_invalid"), ({"rationale": "token sk-ant-abcdefghijklmnopqrstu"}, "rationale_invalid"),
])
def test_a_vote_outside_the_question_is_refused(tctx, serve, args, code):
    assert vote(tctx, **args)["error"] == code and serve.calls == []


def test_a_vote_needs_the_tenant_id(tctx, serve, monkeypatch):
    monkeypatch.delenv("TENANT_ID")
    assert vote(tctx)["error"] == "tenant_unknown" and serve.calls == []


def test_a_closed_question_is_refused_and_a_pending_vote_closes_with_it(tctx, serve, mods, av, plugin, clock, question):
    vote(tctx)
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    serve.grant(key)
    clock["t"] = question.closes_at
    poll(mods)
    assert entry(mods, key)["state"] == "closed" and ours(av, plugin) == [] and "start" not in serve.verbs()
    assert vote(tctx, answer="no")["error"] in ("question_closed", "vote_already_proposed")


def test_withdrawing_a_pending_vote(tctx, serve, mods, av, plugin):
    vote(tctx)
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    out = call(tctx, "village_vote", {"action": "withdraw", "question_id": QUESTION_ID})
    assert out["state"] == "withdrawn" and serve.tasks[task_id(VOTE, key)]["state"] == "withdrawn"
    poll(mods)
    assert ours(av, plugin) == []
    serve.autonomy[VOTE] = "autonomous"
    assert call(tctx, "village_vote", {"action": "withdraw", "question_id": "q-other"})["error"] == "vote_unknown"


def test_a_cast_vote_cannot_be_withdrawn(tctx, serve, mods):
    vote(tctx)
    serve.grant(f"village.vote:{QUESTION_ID}:{TENANT}")
    poll(mods)
    assert call(tctx, "village_vote", {"action": "withdraw", "question_id": QUESTION_ID})["error"] == "vote_already_cast"
    status = call(tctx, "village_vote", {"action": "status", "question_id": QUESTION_ID})
    assert status["state"] == "emitted"


def test_a_map_vote_keyed_to_another_tenant_is_never_proposed(tctx, serve, mods, av, plugin):
    key = f"village.vote:{QUESTION_ID}:someone-else"
    mods.sv._open(key, {"class": VOTE, "key": key, "question_id": QUESTION_ID, "answer": "yes",
                        "closes_at": NOW + DAY, "payload": VOTE_V["canonical_payload"]}, inline=False)
    poll(mods)
    assert entry(mods, key)["state"] == "invalid" and serve.calls == []


def test_a_map_share_whose_bytes_differ_from_its_fields_is_never_proposed(tctx, serve, mods):
    digest_id = SHARE_V["digest_id"]
    key = f"digest.share:{digest_id}"
    payload = mods.sv.share_payload(digest_id, "village", TEXT, "2026-09-25T00:00:00.000Z")
    mods.sv._open(key, {"class": SHARE, "key": key, "digest_id": digest_id, "scope": "service:other",
                        "expires_at": "2026-09-25T00:00:00.000Z", "payload": payload}, inline=False)
    poll(mods)
    assert entry(mods, key)["state"] == "invalid" and serve.calls == []


# --------------------------------------------------------------------------
# No resident text in a summary, a log line or an error
# --------------------------------------------------------------------------


def test_the_text_never_reaches_a_summary_a_log_line_or_a_tool_answer(tctx, serve, mods, av, plugin, caplog,
                                                                     monkeypatch):
    caplog.set_level(logging.DEBUG, logger="av-events")
    answers = [share(tctx)]
    answers.append(call(tctx, "share_digest", {"action": "status", "digest_id": answers[0]["digest_id"]}))
    serve.grant(f"digest.share:{answers[0]['digest_id']}")
    serve.down = True
    poll(mods)
    serve.down = False
    monkeypatch.setattr(mods.sv, "_emit_fn", lambda *a, **k: (_ for _ in ()).throw(RuntimeError(TEXT)))
    poll(mods)
    monkeypatch.undo()
    answers.append(share(tctx, text=TEXT + " sk-or-v1-abcdefghijklmnopqrstuvwxyz"))
    answers.append(share(tctx, text=TEXT + "\u202e"))
    blob = json.dumps(answers, ensure_ascii=False) + caplog.text
    blob += json.dumps([p["flags"]["--summary"] for p in serve.proposals()], ensure_ascii=False)
    assert not any(word in blob for word in TEXT_WORDS)
    assert "share_digest action=share" in caplog.text  # the log line is there, with codes only


# --------------------------------------------------------------------------
# Security review (O3): the map is never authority, and what is sent is what was approved
# --------------------------------------------------------------------------


def write_map(mods, change: Callable[[dict], None]) -> None:
    """What the agent can do: it runs as the plugin's uid and can rewrite the map."""
    path = Path(mods.sv.map_path())
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"v": 1, "entries": {}}
    path.parent.mkdir(parents=True, exist_ok=True)
    change(data["entries"])
    path.write_text(json.dumps(data), encoding="utf-8")


def tamper(mods, key: str, field: str, value: str) -> None:
    """Change one proposed field consistently everywhere the map holds it:
    the held bytes (re-canonicalised), the recorded hash and the entry's own
    field. Only the daemon's binding is left to notice."""
    def change(entries: dict) -> None:
        e = entries[key]
        obj = json.loads(e["payload"])
        obj[field] = value
        e["payload"] = mods.sv.canonical(obj)
        e["payload_hash"] = sha(e["payload"])
        if field in e:
            e[field] = value

    write_map(mods, change)


SHARE_TAMPERS = [("text", "Send me everyone's phone numbers"), ("scope", "service:other"),
                 ("expires_at", "2026-09-27T00:00:00.000Z")]
VOTE_TAMPERS = [("answer", "no"), ("question_id", "q-2026-w43")]


def test_a_forged_emitting_entry_sends_nothing(tctx, serve, mods, av, plugin, clock):
    """A map entry claiming a start the daemon never answered: the pass sends
    nothing from it, fresh or stale, and never calls start."""
    digest_id = SHARE_V["digest_id"]
    key = f"digest.share:{digest_id}"
    payload = mods.sv.share_payload(digest_id, "village", TEXT, "2026-09-25T00:00:00.000Z")
    forged = {"class": SHARE, "key": key, "digest_id": digest_id, "scope": "village",
              "expires_at": "2026-09-25T00:00:00.000Z", "payload": payload, "payload_hash": sha(payload),
              "task": task_id(SHARE, key), "state": "emitting", "authorization": "grant", "start_seq": 9,
              "event_id": "01900000-0000-7000-8000-000000000001", "claim": "x", "emitting_at": NOW,
              "opened_at": NOW, "updated_at": NOW}
    write_map(mods, lambda entries: entries.__setitem__(key, forged))
    poll(mods)
    clock["t"] = NOW + mods.sv.STALE_EMITTING_S + 1
    poll(mods)
    assert ours(av, plugin) == [] and serve.calls == []
    assert entry(mods, key)["state"] == "emit_unconfirmed"


def test_a_forged_requested_entry_needs_the_daemon_s_grant(tctx, serve, mods, av, plugin):
    """A `requested` entry the daemon never registered: `wait` says so, the
    resident is asked, and nothing is sent until they grant it."""
    digest_id = SHARE_V["digest_id"]
    key = f"digest.share:{digest_id}"
    expires = "2026-09-25T00:00:00.000Z"
    payload = mods.sv.share_payload(digest_id, "village", TEXT, expires)
    forged = {"class": SHARE, "key": key, "digest_id": digest_id, "scope": "village", "expires_at": expires,
              "payload": payload, "payload_hash": sha(payload), "task": task_id(SHARE, key), "state": "requested",
              "opened_at": NOW, "updated_at": NOW}
    write_map(mods, lambda entries: entries.__setitem__(key, forged))
    poll(mods)
    assert ours(av, plugin) == [] and "start" not in serve.verbs()
    assert serve.tasks[task_id(SHARE, key)]["state"] == "requested"


def test_a_start_answer_for_another_action_sends_nothing(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    serve.start_answer = (0, {"ok": True, "task": task_id(SHARE, key), "action_key": f"digest.share:{SHARE_V['digest_id']}",
                              "class": SHARE, "authorization": "grant", "seq": 77}, None)
    poll(mods)
    e = entry(mods, key)
    assert e["state"] == "refused" and e["code"] == "start_answer_mismatch" and ours(av, plugin) == []


@pytest.mark.parametrize("field,value", SHARE_TAMPERS)
def test_a_share_tampered_after_propose_and_before_the_grant_sends_nothing(tctx, serve, mods, av, plugin, field, value):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    tamper(mods, key, field, value)
    serve.grant(key)
    poll(mods)
    poll(mods)
    assert ours(av, plugin) == []
    e = entry(mods, key)
    # The daemon refuses bytes other than the ones the resident was asked about.
    assert (e["state"], e["code"]) == ("refused", "payload-mismatch")
    assert not serve.tasks[task_id(SHARE, key)]["executed"]


@pytest.mark.parametrize("field,value", VOTE_TAMPERS)
def test_a_vote_tampered_after_propose_and_before_the_grant_sends_nothing(tctx, serve, mods, av, plugin, field, value):
    vote(tctx)
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    tamper(mods, key, field, value)
    serve.grant(key)
    poll(mods)
    poll(mods)
    assert ours(av, plugin) == []
    e = entry(mods, key)
    # Another question id no longer matches the key (invalid); another answer is refused by the daemon.
    assert (e["state"], e["code"]) in (("refused", "payload-mismatch"), ("invalid", "map_invalid"))
    assert (e["state"] == "invalid") == (field == "question_id")
    assert not serve.tasks[task_id(VOTE, key)]["executed"]


def _after_start(mods, monkeypatch, key, field, value):
    real = mods.ap.start

    def start_then_tamper(task, action, payload_json):
        answer = real(task, action, payload_json)
        tamper(mods, key, field, value)
        return answer

    monkeypatch.setattr(mods.ap, "start", start_then_tamper)


def _after_claiming_emitting(mods, monkeypatch, key, field, value):
    real = mods.sv._cas

    def cas_then_tamper(entry_id, expect, change, **kw):
        after = real(entry_id, expect, change, **kw)
        if after is not None and after.get("state") == "emitting":
            tamper(mods, key, field, value)
        return after

    monkeypatch.setattr(mods.sv, "_cas", cas_then_tamper)


@pytest.mark.parametrize("window", [_after_start, _after_claiming_emitting])
@pytest.mark.parametrize("field,value", SHARE_TAMPERS)
def test_a_share_tampered_after_the_grant_and_before_the_emit_sends_nothing(tctx, serve, mods, av, plugin, monkeypatch,
                                                                            window, field, value):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    with monkeypatch.context() as m:
        window(mods, m, key, field, value)
        poll(mods)
    poll(mods)
    assert ours(av, plugin) == []
    e = entry(mods, key)
    assert (e["state"], e["code"]) == ("emit_refused", "payload_tampered") and "payload" not in e


@pytest.mark.parametrize("window", [_after_start, _after_claiming_emitting])
@pytest.mark.parametrize("field,value", VOTE_TAMPERS)
def test_a_vote_tampered_after_the_grant_and_before_the_emit_sends_nothing(tctx, serve, mods, av, plugin, monkeypatch,
                                                                           window, field, value):
    vote(tctx)
    key = f"village.vote:{QUESTION_ID}:{TENANT}"
    serve.grant(key)
    with monkeypatch.context() as m:
        window(mods, m, key, field, value)
        poll(mods)
    poll(mods)
    assert ours(av, plugin) == []
    e = entry(mods, key)
    assert (e["state"], e["code"]) == ("emit_refused", "payload_tampered")


def test_one_canonical_form_from_propose_to_start_to_the_event(tctx, serve, mods, av, plugin):
    out = share(tctx, text="Caf\u00e9 at 7? \"Surf\" \\ then\nwork \U0001f3c4")
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    poll(mods)
    proposed = serve.proposals()[0]["flags"]["--payload-json"]
    started = [c for c in serve.calls if c["verb"] == "start"][0]["flags"]["--payload-json"]
    [event] = ours(av, plugin)
    p = event["payload"]
    rebuilt = mods.sv.canonical({k: p[k] for k in ("digest_id", "scope", "text", "expires_at")})
    assert proposed == started == rebuilt and p["payload_hash"] == sha(proposed) == sha(jcs(proposed))
