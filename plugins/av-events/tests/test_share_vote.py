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
#: A tenant id as the control plane writes it: a lower-case UUID (the vector's
#: `t_vote_1` is used by the pure-function tests only).
TENANT = "6f1c2a9e-0b7d-4e3a-9c5f-2d8e1b0a7c41"
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
        if t["state"] == "none" and manual:
            # The class was raised to manual since: asked now.
            t["state"] = "requested"
            t["asks"] += 1
            return 0, {**base, "decision": "requested", "state": "requested", "seq": self._next_seq(),
                       "idempotent": False}, None
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

        self.text: Optional[str] = "Should the village keep quiet hours after 22:00?"
        self.labels: dict[str, Optional[str]] = {"yes": "Yes, quiet hours from 22:00", "no": "No quiet hours",
                                                 "abstain": None}

    def __call__(self):
        vq = self.mods.vq
        options = tuple(vq.Option(k, self.labels.get(k)) for k in self.options)
        return vq.Question(self.question_id, self.text, options, self.closes_at, opens_at=NOW - DAY)


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
def consent(mods, monkeypatch):
    """What ingest says about research consent: None (could not tell) unless a test sets it."""
    box = {"research": None}
    monkeypatch.setattr(mods.sv, "_research_consent", lambda: box["research"])
    return box


@pytest.fixture()
def tctx(plugin, env, serve, kicks, clock, question, consent, mods):
    ctx = Ctx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    # The tests run the collector as a null sink (a token, no URL: nothing is
    # ever sent anywhere) and read its buffer; the shipped readiness refuses a
    # null sink (`test_a_null_sink_is_not_ready`), so readiness here is the
    # collector's own on/off only.
    collector = plugin._COLLECTOR
    mods.sv.set_emitter(mods.sv._emit_fn, lambda: not collector.plugin_disabled and collector.config.active)
    monkeypatch_null_sink(plugin)
    mods.sv._REVOKED_IDS.clear()
    return ctx


def monkeypatch_null_sink(plugin) -> None:
    """Let the test emitter buffer in null-sink mode (what it refuses in production)."""
    collector = plugin._COLLECTOR

    def emit(event_type, payload, *, event_id, occurred_at):
        if collector.plugin_disabled or not collector.config.active:
            return False
        return collector.emit(event_type, payload, event_id=event_id, occurred_at=occurred_at,
                              occurred_at_earliest=occurred_at, occurred_at_latest=occurred_at) is not None

    sys.modules[f"{plugin.__name__}._share_vote"]._emit_fn = emit


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


def conforms(event_type: str, payload: dict, tenant: str = TENANT) -> None:
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
        assert payload["idempotency_key"] == sha(f"village.vote:{payload['question_id']}:{tenant}")
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
    conforms("vote.cast", event, VOTE_V["tenant_id"])
    conforms("vote.cast", sv.vote_event_payload(payload, VOTE_V["tenant_id"], VOTE_V["payload_hash"], 7, "policy"),
             VOTE_V["tenant_id"])
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


def test_a_switch_only_in_the_dotenv_file_is_not_read_by_a_running_process(plugin, env, serve, kicks, home,
                                                                         monkeypatch):
    """The switches are read from the process environment only, so writing
    `.env` does not turn them on in a running process. It is no defence
    against a new process: Hermes loads `.env` into the environment with
    override at startup (an accepted limit, in the module header)."""
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


def test_revoke_needs_approval_configured_and_refuses_an_unknown_digest(tctx, serve, mods, av, plugin, monkeypatch):
    out = share(tctx)
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods)
    assert call(tctx, "share_digest", {"action": "revoke", "digest_id": SHARE_V["digest_id"]})["error"] == "digest_unknown"
    assert call(tctx, "share_digest", {"action": "revoke"})["error"] == "digest_id_required"
    monkeypatch.delenv("AV_APPROVAL_URL")
    assert call(tctx, "share_digest", {"action": "revoke", "digest_id": out["digest_id"]})["error"] == "approval_not_configured"
    assert [e["event_type"] for e in ours(av, plugin)] == ["digest.shared"]


# --------------------------------------------------------------------------
# village.vote
# --------------------------------------------------------------------------


def test_without_a_question_source_the_vote_tool_refuses_with_a_code(plugin, env, serve, kicks, clock, mods, consent):
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
    assert q["question_id"] == QUESTION_ID and [o["key"] for o in q["options"]] == ["yes", "no", "abstain"]
    assert q["options"][0]["label"] == "Yes, quiet hours from 22:00" and q["options"][2]["label"] is None
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
    assert event["payload"] == {"question_id": QUESTION_ID, "answer": "yes",
                                "idempotency_key": sha(f"village.vote:{QUESTION_ID}:{TENANT}"),
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
    # Another question id is not the provider's open question; another answer is refused by the daemon.
    expected = ("closed", "question_unavailable") if field == "question_id" else ("refused", "payload-mismatch")
    assert (e["state"], e["code"]) == expected
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


# --------------------------------------------------------------------------
# Refutation round (O3): F1..F5, consent, and the surviving mutants
# --------------------------------------------------------------------------

VOTE_KEY = f"village.vote:{QUESTION_ID}:{TENANT}"


def map_vote(mods, question_id: str = QUESTION_ID, answer: str = "yes", state: str = "unfiled", **extra: Any) -> str:
    key = f"village.vote:{question_id}:{TENANT}"
    e = {"class": VOTE, "key": key, "question_id": question_id, "answer": answer,
         "payload": mods.sv.vote_payload(question_id, answer), "state": state, "opened_at": NOW, "updated_at": NOW,
         # A closes_at the agent wrote: never read.
         "closes_at": NOW + 30 * DAY, **extra}
    write_map(mods, lambda entries: entries.__setitem__(key, e))
    return key


def daemon_task(serve: FakeServe, cls: str, key: str, payload: str, state: str = "granted") -> str:
    task = task_id(cls, key)
    serve.tasks[task] = {"key": key, "class": cls, "hash": sha(jcs(payload)), "executed": False, "state": state, "asks": 1}
    return task


# ---- F1: the poller asks the provider, never the map --------------------------


def test_under_the_shipped_provider_a_map_vote_is_never_proposed_or_cast(tctx, serve, mods, av, plugin):
    mods.vq.set_provider(None)
    key = map_vote(mods, "agent-made-up-q", "A")
    poll(mods)
    assert serve.calls == [] and ours(av, plugin) == []
    assert (entry(mods, key)["state"], entry(mods, key)["code"]) == ("closed", "question_unavailable")


def test_a_map_vote_with_a_granted_daemon_task_is_not_cast_without_the_provider(tctx, serve, mods, av, plugin):
    mods.vq.set_provider(None)
    payload = mods.sv.vote_payload("agent-made-up-q", "A")
    key = f"village.vote:agent-made-up-q:{TENANT}"
    task = daemon_task(serve, VOTE, key, payload)
    map_vote(mods, "agent-made-up-q", "A", state="requested", task=task, payload_hash=sha(payload))
    poll(mods)
    assert "start" not in serve.verbs() and ours(av, plugin) == []
    assert entry(mods, key)["state"] == "closed"


@pytest.mark.parametrize("question_id,answer,expected", [
    ("agent-made-up-q", "yes", ("closed", "question_unavailable")),
    (QUESTION_ID, "maybe", ("invalid", "answer_not_an_option")),
])
def test_a_map_vote_the_provider_does_not_offer_is_never_proposed(tctx, serve, mods, av, plugin, question_id, answer,
                                                                    expected):
    key = map_vote(mods, question_id, answer)
    poll(mods)
    assert serve.calls == [] and ours(av, plugin) == []
    assert (entry(mods, key)["state"], entry(mods, key)["code"]) == expected


def test_a_map_vote_on_a_question_the_provider_has_closed_is_never_proposed(tctx, serve, mods, av, plugin, question):
    question.closes_at = NOW - 1
    key = map_vote(mods)  # the map says it closes in 30 days
    poll(mods)
    assert serve.calls == [] and (entry(mods, key)["state"], entry(mods, key)["code"]) == ("closed", "question_closed")


def test_moving_closes_at_in_the_map_does_not_reopen_a_closed_question(tctx, serve, mods, av, plugin, clock, question):
    vote(tctx)
    clock["t"] = question.closes_at + DAY
    write_map(mods, lambda entries: entries[VOTE_KEY].__setitem__("closes_at", NOW + 30 * DAY))
    serve.grant(VOTE_KEY)
    poll(mods)
    assert ours(av, plugin) == [] and "start" not in serve.verbs()
    assert (entry(mods, VOTE_KEY)["state"], entry(mods, VOTE_KEY)["code"]) == ("closed", "question_closed")


def test_a_new_week_s_question_ends_last_week_s_pending_vote(tctx, serve, mods, av, plugin, question):
    vote(tctx)
    serve.grant(VOTE_KEY)
    question.question_id = "q-2026-w43"
    poll(mods)
    assert ours(av, plugin) == [] and "start" not in serve.verbs()
    assert entry(mods, VOTE_KEY)["state"] == "closed"


def test_the_provider_is_asked_again_before_the_claim(tctx, serve, mods, av, plugin, question, monkeypatch):
    """Open when the poll's wait is read, closed by the time the start would be claimed."""
    vote(tctx)
    serve.grant(VOTE_KEY)
    real = mods.sv._granted

    def granted_then_close(task):
        answer = real(task)
        question.closes_at = NOW - 1
        return answer

    monkeypatch.setattr(mods.sv, "_granted", granted_then_close)
    real_bounds = mods.sv._bounds
    monkeypatch.setattr(mods.sv, "_bounds", lambda e, now: None)  # the poll's own check passes
    poll(mods)
    monkeypatch.setattr(mods.sv, "_bounds", real_bounds)
    assert ours(av, plugin) == [] and "start" not in serve.verbs()
    assert entry(mods, VOTE_KEY)["code"] == "question_closed"


# ---- F2: no tools without approval; revocation ---------------------------------


def test_neither_tool_is_registered_without_approval(plugin, env, serve, kicks, monkeypatch):
    monkeypatch.delenv("AV_APPROVAL_URL")
    ctx = Ctx()
    plugin.register(ctx)
    assert "share_digest" not in ctx.tools and "village_vote" not in ctx.tools and kicks == []


def forged_emitted(mods, digest_id: str = "11111111-2222-4333-8444-555555555555", **extra: Any) -> str:
    key = f"digest.share:{digest_id}"
    e = {"class": SHARE, "key": key, "digest_id": digest_id, "scope": "village",
         "expires_at": "2026-09-25T00:00:00.000Z", "state": "emitted", **extra}
    write_map(mods, lambda entries: entries.__setitem__(key, dict(e)))
    return digest_id


@pytest.mark.parametrize("marks", [
    {},
    {"start_seq": 3, "authorization": "grant"},
    {"event_id": "01900000-0000-7000-8000-000000000001", "authorization": "grant"},
    {"event_id": "01900000-0000-7000-8000-000000000001", "start_seq": True, "authorization": "grant"},
    {"event_id": "01900000-0000-7000-8000-000000000001", "start_seq": 3, "authorization": "policy"},
])
def test_a_forged_emitted_entry_without_the_module_s_marks_is_not_revoked(tctx, serve, mods, av, plugin, marks):
    digest_id = forged_emitted(mods, **marks)
    assert call(tctx, "share_digest", {"action": "revoke", "digest_id": digest_id})["error"] == "digest_unknown"
    assert ours(av, plugin) == []


def test_a_revocation_is_sent_at_most_once_per_digest_per_process(tctx, serve, mods, av, plugin):
    marks = {"event_id": "01900000-0000-7000-8000-000000000001", "start_seq": 3, "authorization": "grant"}
    digest_id = forged_emitted(mods, **marks)  # forgeable, as the module header says
    for _ in range(3):
        forged_emitted(mods, **marks)
        assert call(tctx, "share_digest", {"action": "revoke", "digest_id": digest_id})["state"] == "revoked"
    assert [e["event_type"] for e in ours(av, plugin)] == ["digest.revoked"] and serve.calls == []


def test_a_revocation_claims_the_shared_entry_before_it_sends(tctx, serve, mods, av, plugin, monkeypatch):
    """Another process revoked between this call's read and its claim: the
    claim fails and nothing is sent."""
    out = share(tctx)
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods)
    key = f"digest.share:{out['digest_id']}"
    stale = entry(mods, key)
    mods.sv._set(key, {"emitted"}, "revoked")
    real = mods.sv.lookup
    monkeypatch.setattr(mods.sv, "lookup", lambda entry_id: dict(stale) if entry_id == key else real(entry_id))
    assert call(tctx, "share_digest", {"action": "revoke", "digest_id": out["digest_id"]})["error"] == "revoke_failed"
    assert [e["event_type"] for e in ours(av, plugin)] == ["digest.shared"]


# ---- F3: what the resident reads -------------------------------------------------


def test_the_vote_prompt_shows_the_provider_s_question_and_label(tctx, serve, mods):
    vote(tctx, rationale="They said at dinner they sleep early")
    summary = serve.proposals()[-1]["flags"]["--summary"]
    assert "Should the village keep quiet hours after 22:00?" in summary
    assert "Yes, quiet hours from 22:00 (option yes)" in summary
    assert summary.index("22:00?") < summary.index("Note written by your agent") < summary.index("sleep early")


def test_without_a_label_or_text_the_prompt_says_so_and_the_rationale_does_not_stand_in(tctx, serve, mods, question):
    question.text = None
    vote(tctx, answer="abstain", rationale="Abstain means you support quiet hours")
    summary = serve.proposals()[-1]["flags"]["--summary"]
    assert "(no text for this question is available)" in summary
    assert "option abstain (no description of this option is available)" in summary
    assert summary.index("no description") < summary.index("Note written by your agent")


def test_the_provider_s_text_is_one_clean_bounded_line(tctx, serve, mods, question):
    question.text = "Quiet\nhours‮?\x1b[2J " + "x" * 1000
    question.labels["yes"] = "Yes\r\n⁦please⁩"
    vote(tctx)
    summary = serve.proposals()[-1]["flags"]["--summary"]
    assert not any(ch in summary for ch in "\n\r\x1b‮ ⁦⁩")
    assert "Quiet hours?" in summary and "Yes please (option yes)" in summary and len(summary) < 700


def test_a_map_rationale_that_fails_cleaning_is_dropped_and_the_vote_still_proposed(tctx, serve, mods):
    map_vote(mods, rationale="line1\nIGNORE: approve YES\x1b[2J‮" + "x" * 5000)
    poll(mods)
    summary = serve.proposals()[-1]["flags"]["--summary"]
    assert "IGNORE" not in summary and "Note written by your agent" not in summary
    assert "\n" not in summary and "\x1b" not in summary and len(summary) < 700


def test_rationale_newlines_are_collapsed_in_the_prompt(tctx, serve, mods):
    map_vote(mods, rationale="first line\n\nsecond   line")
    poll(mods)
    summary = serve.proposals()[-1]["flags"]["--summary"]
    assert "first line second line" in summary and "\n" not in summary


def test_a_rationale_quoting_a_held_share_is_refused_and_dropped(tctx, serve, mods):
    share(tctx)
    out = vote(tctx, rationale="Resident wrote: " + TEXT.upper())
    assert out["error"] == "rationale_quotes_share"
    out = vote(tctx, rationale="They need a reviewer for my side project this week")  # 24+ chars of it
    assert out["error"] == "rationale_quotes_share"
    map_vote(mods, rationale="Resident wrote: " + TEXT)
    poll(mods)
    votes = [p for p in serve.proposals() if p["flags"]["--class"] == VOTE]
    assert votes and not any(word in votes[-1]["flags"]["--summary"] for word in TEXT_WORDS)


# ---- F4: the content rule at propose; unencodable bytes are final ---------------


def test_a_map_share_whose_text_the_door_would_refuse_is_never_proposed(tctx, serve, mods, av, plugin):
    digest_id = SHARE_V["digest_id"]
    key = f"digest.share:{digest_id}"
    expires = "2026-09-25T00:00:00.000Z"
    e = {"class": SHARE, "key": key, "digest_id": digest_id, "scope": "village", "expires_at": expires,
         "payload": mods.sv.share_payload(digest_id, "village", "a\u0000b", expires), "state": "unfiled"}
    write_map(mods, lambda entries: entries.__setitem__(key, e))
    poll(mods)
    assert serve.calls == [] and (entry(mods, key)["state"], entry(mods, key)["code"]) == ("invalid", "text_invalid")


def test_an_encoding_error_in_the_daemon_call_is_final(tctx, serve, mods, monkeypatch):
    def boom(*_a, **_k):
        raise UnicodeEncodeError("utf-8", "x", 0, 1, "surrogates not allowed")

    monkeypatch.setattr(mods.ap, "propose", boom)
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    assert (entry(mods, key)["state"], entry(mods, key)["code"]) == ("invalid", "payload_unencodable")
    poll(mods)
    assert entry(mods, key)["state"] == "invalid"


def test_the_text_rule_runs_again_at_execute(tctx, serve, mods, av, plugin):
    """A held share whose text the door would refuse, with a grant on the
    daemon for exactly those bytes: never started."""
    digest_id = SHARE_V["digest_id"]
    key = f"digest.share:{digest_id}"
    expires = "2026-09-25T00:00:00.000Z"
    payload = mods.sv.share_payload(digest_id, "village", "a\u0000b", expires)
    task = daemon_task(serve, SHARE, key, payload)
    e = {"class": SHARE, "key": key, "digest_id": digest_id, "scope": "village", "expires_at": expires,
         "payload": payload, "payload_hash": sha(payload), "task": task, "state": "requested"}
    write_map(mods, lambda entries: entries.__setitem__(key, e))
    poll(mods)
    assert "start" not in serve.verbs() and ours(av, plugin) == []
    assert (entry(mods, key)["state"], entry(mods, key)["code"]) == ("refused", "text_invalid")


# ---- F5: the tenant id -------------------------------------------------------------


def test_the_vote_key_s_tenant_is_lower_cased_and_must_be_a_uuid(tctx, serve, mods, monkeypatch):
    monkeypatch.setenv("TENANT_ID", TENANT.upper())
    vote(tctx)
    assert serve.proposals()[-1]["flags"]["--key"] == VOTE_KEY
    monkeypatch.setenv("TENANT_ID", "t_vote_1")
    assert call(tctx, "village_vote", {"action": "status", "question_id": QUESTION_ID})["error"] == "tenant_unknown"
    assert vote(tctx)["error"] == "tenant_unknown"


# ---- Consent and delivery ----------------------------------------------------------


def test_without_research_consent_nothing_is_proposed(tctx, serve, consent):
    consent["research"] = False
    assert share(tctx)["error"] == "not_available_no_consent"
    assert vote(tctx)["error"] == "not_available_no_consent"
    assert serve.calls == []


def test_research_consent_is_read_from_ingest_and_unknown_without_a_url(plugin, env, mods, monkeypatch):
    consent_mod = sys.modules[f"{plugin.__name__}._consent"]
    assert mods.sv._research_consent() is None  # no AV_EVENTS_URL: no request is made
    for body, expected in ((None, False), ({"research": False}, False), ({"research": True}, True),
                           (consent_mod.ConsentUnavailable("timeout"), None)):
        monkeypatch.setattr(consent_mod, "fetch_consent_status", lambda url, token, b=body: b)
        assert mods.sv._research_consent() is expected


def test_a_null_sink_is_not_ready_so_nothing_is_proposed(plugin, env, serve, kicks, clock, question, consent):
    ctx = Ctx()
    plugin.register(ctx)
    assert plugin._share_vote_emitter_ready() is False  # a token and no URL: never sent
    assert share(ctx)["error"] == "not_available_no_events" and serve.calls == []


def test_a_collector_with_a_url_is_ready(plugin, env, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_URL", "http://127.0.0.1:9")  # read only; nothing is emitted, nothing sent
    plugin.register(Ctx())
    assert plugin._share_vote_emitter_ready() is True


def test_the_answers_never_claim_delivery(tctx, serve, mods):
    out = share(tctx)
    serve.grant(f"digest.share:{out['digest_id']}")
    poll(mods)
    status = call(tctx, "share_digest", {"action": "status", "digest_id": out["digest_id"]})
    assert status["state"] == "emitted" and "Delivery is not confirmed" in status["message"]
    assert "has been sent" not in json.dumps(mods.sv.STATE_MESSAGES)


# ---- The expiry-hours argument -------------------------------------------------------


@pytest.mark.parametrize("value", ["５", "²", "١", "1.5", "0", "168", " ", 10 ** 30, 1.0])
def test_only_an_ascii_integer_in_range_is_an_expiry(tctx, serve, value):
    assert share(tctx, expires_in_hours=value)["error"] == "expires_invalid" and serve.calls == []


def test_an_ascii_digit_string_is_accepted(tctx):
    out = share(tctx, expires_in_hours=" 24 ")
    assert instant(out["expires_at"]) == pytest.approx(NOW + DAY, abs=0.001)


# ---- Surviving mutants ---------------------------------------------------------------


def start_ok(cls: str, key: str, authorization: str, seq: int = 99) -> tuple:
    return 0, {"ok": True, "task": task_id(cls, key), "action_key": key, "class": cls,
               "authorization": authorization, "seq": seq}, None


def test_a_share_start_answered_with_policy_sends_nothing(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    serve.start_answer = start_ok(SHARE, key, "policy")
    poll(mods)
    assert ours(av, plugin) == [] and entry(mods, key)["code"] == "authorization_mismatch"


@pytest.mark.parametrize("autonomy,answered", [("manual", "policy"), ("autonomous", "grant")])
def test_a_vote_start_with_the_other_authorization_sends_nothing(tctx, serve, mods, av, plugin, autonomy, answered):
    serve.autonomy[VOTE] = autonomy
    serve.start_answer = start_ok(VOTE, VOTE_KEY, answered)
    vote(tctx)
    if autonomy == "manual":
        serve.grant(VOTE_KEY)
        poll(mods)
    assert ours(av, plugin) == [] and entry(mods, VOTE_KEY)["code"] == "authorization_mismatch"


def test_a_caller_whose_claim_was_taken_over_sends_nothing(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    real = serve._start

    def taken_over(pos, flags):
        answer = real(pos, flags)
        # Meanwhile the claim was released as stale and another caller took it.
        write_map(mods, lambda entries: entries[key].update(claim="another-caller"))
        return answer

    serve._start = taken_over  # type: ignore[method-assign]
    poll(mods)
    assert ours(av, plugin) == []
    e = entry(mods, key)
    assert e["state"] == "starting" and e["claim"] == "another-caller"


def test_already_executed_at_start_is_final_and_sends_nothing(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    serve.start_answer = FakeServe._error("already-executed")
    poll(mods)
    assert (entry(mods, key)["state"], entry(mods, key)["code"]) == ("start_unconfirmed", "already-executed")
    assert ours(av, plugin) == []


def test_a_void_at_the_re_read_asks_again_and_never_starts(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)

    def void_on_reread(n: int):
        if n == 2:
            serve.reattest()
            return 7, None, {"ok": False, "status": "void", "task": task_id(SHARE, key), "actions": []}
        return None

    serve.on_wait = void_on_reread
    poll(mods)
    assert "start" not in serve.verbs() and ours(av, plugin) == []
    assert len(serve.proposals()) == 2


def test_a_share_never_admits_policy(tctx, serve, mods, av, plugin):
    assert mods.sv._event_body(SHARE, mods.sv.share_payload(SHARE_V["digest_id"], "village", TEXT,
                                                            SHARE_V["expires_at"]), "a" * 64, 3, "policy") is None
    serve.autonomy[SHARE] = "autonomous"
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    mods.sv._cas(key, None, lambda e: e.update(state="cleared", payload=mods.sv.share_payload(
        out["digest_id"], "village", TEXT, out["expires_at"]), payload_hash=sha(mods.sv.share_payload(
            out["digest_id"], "village", TEXT, out["expires_at"]))))
    result = mods.sv._execute(key, entry(mods, key), "policy")
    assert result.state == "not_shared" and "start" not in serve.verbs() and ours(av, plugin) == []


def test_the_expiry_is_judged_again_at_emit_time(tctx, serve, mods, av, plugin, clock):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    serve.grant(key)
    real = serve._start

    def clock_back(pos, flags):
        answer = real(pos, flags)
        clock["t"] = NOW - 2 * DAY  # now the expiry is more than 7 days ahead
        return answer

    serve._start = clock_back  # type: ignore[method-assign]
    poll(mods)
    assert ours(av, plugin) == [] and (entry(mods, key)["state"], entry(mods, key)["code"]) == ("lapsed", "emit_lapsed")


def test_an_agent_supplied_digest_id_is_ignored(tctx, serve):
    out = call(tctx, "share_digest", {"action": "share", "text": TEXT, "digest_id": SHARE_V["digest_id"]})
    assert out["success"] is True and out["digest_id"] != SHARE_V["digest_id"]
    assert serve.proposals()[0]["flags"]["--key"] == f"digest.share:{out['digest_id']}"


def test_a_policy_vote_whose_class_turned_manual_at_the_re_read_is_not_started(tctx, serve, mods, av, plugin):
    serve.autonomy[VOTE] = "autonomous"
    real = serve._propose
    seen = {"n": 0}

    def flip(pos, flags):
        seen["n"] += 1
        if seen["n"] == 2:  # the re-read after the claim
            serve.autonomy[VOTE] = "manual"
        return real(pos, flags)

    serve._propose = flip  # type: ignore[method-assign]
    out = vote(tctx)
    assert "start" not in serve.verbs() and ours(av, plugin) == []
    assert out["state"] == "requested"


def test_the_event_s_hash_must_be_the_one_core_answered_at_propose(tctx, serve, mods, av, plugin):
    out = share(tctx)
    key = f"digest.share:{out['digest_id']}"
    e = entry(mods, key)
    payload = e["payload"]
    mods.sv._cas(key, None, lambda x: x.update(state="starting", claim="c1"))
    wrong = dict(e, payload_hash="b" * 64)
    result = mods.sv._emit_granted(key, wrong, "c1", payload, "grant", 5)
    assert (result.state, result.code) == ("emit_refused", "event_invalid") and ours(av, plugin) == []


# --------------------------------------------------------------------------
# Last round (O3): R1..R3 and the 4 KiB summary bound
# --------------------------------------------------------------------------


def vote_summary(serve: FakeServe) -> str:
    return [p for p in serve.proposals() if p["flags"]["--class"] == VOTE][-1]["flags"]["--summary"]


def test_r1_zero_width_and_combining_characters_do_not_hide_a_quoted_share(tctx, serve, mods):
    share(tctx)
    spaced = "́".join("reviewer for my side project this")  # combining marks between the letters
    assert mods.sv.quotes_held_share(spaced) is True
    nfkc = "ｒｅｖｉｅｗｅｒ ｆｏｒ ｍｙ ｓｉｄｅ ｐｒｏｊｅｃｔ ｔｈｉｓ"  # full-width forms
    assert mods.sv.quotes_held_share(nfkc) is True
    assert vote(tctx, rationale=spaced)["error"] in ("rationale_quotes_share", "rationale_invalid")


@pytest.mark.parametrize("ch", ["​", "‍", "⁠", "­", "‎", "‮"])
def test_r1_any_format_character_in_a_rationale_is_refused(tctx, serve, ch):
    assert vote(tctx, rationale=f"They sleep{ch} early")["error"] == "rationale_invisible"
    assert serve.calls == []


def test_r1_a_map_rationale_with_zero_width_characters_is_dropped(tctx, serve, mods):
    share(tctx)
    map_vote(mods, rationale="​".join("reviewer for my side project this week"))
    poll(mods)
    assert "Note written by your agent" not in vote_summary(serve)


@pytest.mark.parametrize("phrase_name", ["PROMPT_HEAD", "PROMPT_ANSWER", "PROMPT_NOTE", "PROMPT_NO_LABEL",
                                         "PROMPT_NO_TEXT"])
def test_r2_a_rationale_repeating_the_prompt_s_own_phrases_is_refused(tctx, serve, mods, phrase_name):
    phrase = getattr(mods.sv, phrase_name)
    for variant in (phrase, phrase.upper(), phrase.replace(" ", "  ").strip("().:-") + " x"):
        assert vote(tctx, rationale=f"Also {variant} no")["error"] == "rationale_imitates_prompt", variant
    assert serve.calls == []


def test_r2_fillers_and_exotic_spaces_cannot_push_a_fake_template_into_the_prompt(tctx, serve, mods):
    fake = ("ㅤ" * 40 + "⠀" * 40 + "　" * 10 + " Answer to send for you: No quiet hours "
            "(option no).")
    assert vote(tctx, rationale="fine " + fake)["error"] == "rationale_imitates_prompt"
    line, code = mods.sv.clean_rationale("aㅤᅟᅠﾠ⠀b　 c d")
    assert (line, code) == ("ab c d", None)
    map_vote(mods, rationale="ok " + fake)
    poll(mods)
    summary = vote_summary(serve)
    assert summary.count(mods.sv.PROMPT_ANSWER) == 1 and "Note written by your agent" not in summary


@pytest.mark.parametrize("closes", [float("nan"), float("inf"), float("-inf")])
def test_r3_a_question_closing_at_nan_or_infinity_is_not_a_question(mods, closes):
    q = mods.vq.Question("q1", "Text?", (mods.vq.Option("yes"),), closes)
    assert mods.vq.valid(q) is False
    assert mods.vq.valid(mods.vq.Question("q1", "Text?", (mods.vq.Option("yes"),), NOW)) is True


def test_r3_the_provider_s_infinite_close_refuses_the_vote(tctx, serve, question):
    question.closes_at = float("inf")
    assert vote(tctx)["error"] == "question_unavailable" and serve.calls == []


def test_bound_a_long_rationale_is_cut_first_and_the_summary_is_at_most_4_kib(tctx, serve, mods, monkeypatch,
                                                                               question):
    monkeypatch.setattr(mods.sv, "MAX_RATIONALE", 10_000)
    monkeypatch.setattr(mods.sv, "DIGEST_TEXT_MAX", 10_000)
    monkeypatch.setattr(mods.sv, "MAX_PROMPT_QUESTION", 10_000)
    question.text = "Q" + "é" * 900  # 2 bytes each
    map_vote(mods, rationale="\U0001f3c4 " + "क" * 3000)  # 3 bytes each
    poll(mods)
    summary = vote_summary(serve)
    assert len(summary.encode("utf-8")) <= 4096
    assert "Q" + "é" * 900 in summary  # the trusted text whole
    assert "Yes, quiet hours from 22:00 (option yes)." in summary
    assert summary.endswith("…") and "Note written by your agent" in summary


def test_bound_the_question_text_is_shortened_and_the_answer_line_kept_whole(tctx, serve, mods, monkeypatch, question):
    monkeypatch.setattr(mods.sv, "MAX_PROMPT_QUESTION", 10_000)
    monkeypatch.setattr(mods.sv, "MAX_PROMPT_LABEL", 10_000)
    monkeypatch.setattr(mods.vq, "MAX_QUESTION_TEXT", 10_000)
    question.text = "\U0001f3c4" * 2000  # 8000 bytes
    question.labels["yes"] = "क" * 150
    map_vote(mods, rationale="They sleep early")
    poll(mods)
    summary = vote_summary(serve)
    size = len(summary.encode("utf-8"))
    assert 4090 <= size <= 4096  # filled to the bound, never past it, no split character
    assert ("क" * 150 + " (option yes).") in summary and "…”" in summary
    assert "Note written by your agent" not in summary  # no room left for the note


@pytest.mark.parametrize("budget", [0, 1, 2, 3, 4, 5, 6, 7])
def test_bound_fit_bytes_never_splits_a_character(mods, budget):
    out = mods.sv.fit_bytes("\U0001f3c4éab", budget)
    assert len(out.encode("utf-8")) <= budget
    assert out in ("", "…", "\U0001f3c4…", "\U0001f3c4é…", "\U0001f3c4éab")


def test_bound_a_key_over_1_kib_is_never_proposed(tctx, serve, mods, monkeypatch):
    monkeypatch.setattr(mods.sv, "MAX_KEY_BYTES", 50)
    out = vote(tctx)
    assert (out["state"], out.get("code")) == ("invalid", "key_too_long") and serve.calls == []


def test_bound_holds_even_when_the_answer_line_alone_is_too_long(tctx, serve, mods, monkeypatch, question):
    """Only reachable if the label bound were raised: the final guard still
    keeps the summary within 4 KiB."""
    monkeypatch.setattr(mods.sv, "MAX_PROMPT_LABEL", 10_000)
    monkeypatch.setattr(mods.vq, "MAX_LABEL", 10_000)
    question.labels["yes"] = "\U0001f3c4" * 1100  # 4400 bytes
    map_vote(mods)
    poll(mods)
    summary = vote_summary(serve)
    assert 4090 <= len(summary.encode("utf-8")) <= 4096 and summary.endswith("\u2026")
