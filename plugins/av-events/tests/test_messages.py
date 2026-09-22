"""`message.in` / `message.out` (spec §4.1): channel, length, hash, flags — never text."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import uuid
from pathlib import Path

import pytest

SESSION = "sess-msg"
USER_TEXT = "Can you RSVP me to the hardware dinner? My number is +1 555 0100"
AGENT_TEXT = "Done, you are on the list for the hardware dinner."


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest()


def keyed(text: str) -> str:
    """What the plugin emits for a non-join hash: HMAC-SHA256 under the tenant key."""
    key = (Path(os.environ["HERMES_HOME"]) / "av-events" / "hash.key").read_text(encoding="ascii").strip()
    return hmac.new(bytes.fromhex(key), text.encode("utf-8", errors="surrogatepass"), hashlib.sha256).hexdigest()


def converse(ctx, session=SESSION, platform="telegram", user=USER_TEXT, agent=AGENT_TEXT, task_id=None):
    if platform is not None:
        ctx.fire("on_session_start", session_id=session, model="m", platform=platform)
    ctx.fire("pre_llm_call", session_id=session, task_id=task_id or session, turn_id="t0",
             user_message=user, sender_id="123456789", model="m")
    ctx.fire("post_llm_call", session_id=session, task_id=task_id or session, turn_id="t0",
             assistant_response=agent, model="anthropic/claude-sonnet-4-6")


def messages(av, plugin, kind=None):
    events = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("message.")]
    return [e for e in events if kind is None or e["event_type"] == kind]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    return plugin


def test_a_turn_emits_one_in_and_one_out(live, ctx, av):
    converse(ctx)
    inbound, outbound = messages(av, live, "message.in"), messages(av, live, "message.out")
    assert len(inbound) == 1 and len(outbound) == 1
    assert inbound[0]["actor"] == "participant"
    assert outbound[0]["actor"] == "agent"
    assert outbound[0]["model_id"] == "anthropic/claude-sonnet-4-6"
    for event, text in ((inbound[0], USER_TEXT), (outbound[0], AGENT_TEXT)):
        payload = event["payload"]
        assert payload["channel"] == "telegram"
        assert payload["length"] == len(text)
        assert payload["content_hash"] == keyed(text) != sha(text)
        assert payload["cron_job_id"] is None
        assert set(payload["flags"]) == {"is_ask", "is_recommendation", "sentiment"}
        assert uuid.UUID(event["event_id"]).version == 7
        assert event["session_id"] == SESSION and event["turn_id"] == "t0"


def test_the_message_counts_still_reach_session_ended(live, ctx, av):
    converse(ctx)
    ctx.fire("on_session_finalize", session_id=SESSION)
    ended = [e for e in av.read_buffer(live._COLLECTOR) if e["event_type"] == "session.ended"][0]
    assert ended["payload"]["message_count"] == 2


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_message_text_never_leaves_in_any_mode(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    converse(ctx)
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    for leak in ("RSVP me", "555 0100", "hardware dinner", "on the list", "123456789"):
        assert leak not in blob, (mode, leak)


def test_metadata_keeps_only_the_channel(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    converse(ctx)
    for event in messages(av, plugin):
        payload = event["payload"]
        assert payload["channel"] == "telegram"
        assert payload["length"] is None and payload["content_hash"] is None
        assert payload["flags"] == {"is_ask": None, "is_recommendation": None, "sentiment": None}
        assert payload["flags_rule"] is None


@pytest.mark.parametrize("mode", ["sanitized", "full"])
def test_sanitized_and_full_are_identical(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    converse(ctx)
    payload = messages(av, plugin, "message.in")[0]["payload"]
    assert payload == {
        "channel": "telegram",
        "length": len(USER_TEXT),
        "content_hash": keyed(USER_TEXT),
        "flags": {"is_ask": True, "is_recommendation": None, "sentiment": None},
        "flags_rule": "message_flags_v1",
        "cron_job_id": None,
        "silent": None,
    }


@pytest.mark.parametrize("text,ask", [
    ("Want me to RSVP you?", True),
    ("Shall I? Let me know.", True),
    ("(is that ok?)", True),
    ("See https://example.com/page?x=1 for details.", False),
    ("Done. Nothing else to do.", False),
    ("What?!", True),
    ("Is 3?4 a thing", False),
    ("", False),
])
def test_is_ask_is_a_sentence_ending_question_mark(plugin, text, ask):
    messages_module = __import__(f"{plugin.__name__}._messages", fromlist=["_messages"])
    assert messages_module.is_ask(text) is ask


def test_a_cron_session_is_never_participant_sourced(live, ctx, av):
    session = "cron_ab12cd34ef56_20260922_140000"
    converse(ctx, session=session, platform="cron", task_id="cron:ab12cd34ef56:0f1e2d3c4b5a69788796a5b4c3d2e1f0")
    inbound = messages(av, live, "message.in")[0]
    assert inbound["actor"] == "system"
    assert inbound["payload"]["channel"] == "cron"
    assert inbound["payload"]["cron_job_id"] == "ab12cd34ef56"
    outbound = messages(av, live, "message.out")[0]
    assert outbound["payload"]["channel"] == "cron"
    assert outbound["run_id"] == "cron:ab12cd34ef56:0f1e2d3c4b5a69788796a5b4c3d2e1f0"


def test_a_cron_session_is_recognised_by_its_id_alone(live, ctx, av):
    converse(ctx, session="cron_job1_20260922_140000", platform=None)
    inbound = messages(av, live, "message.in")[0]
    assert inbound["actor"] == "system"
    assert inbound["payload"]["cron_job_id"] == "job1"


def test_a_subagent_goal_is_the_agent_speaking(live, ctx, av):
    ctx.fire("on_session_start", session_id="parent", model="m", platform="telegram")
    ctx.fire("subagent_start", parent_session_id="parent", child_session_id="child", child_goal="find events")
    converse(ctx, session="child", platform=None)
    inbound = messages(av, live, "message.in")[0]
    assert inbound["actor"] == "agent"
    assert inbound["payload"]["channel"] == "subagent"


def test_an_unexpected_platform_string_becomes_other(live, ctx, av):
    converse(ctx, platform="Totally Custom Platform!!")
    assert messages(av, live, "message.in")[0]["payload"]["channel"] == "other"


def test_a_non_string_message_has_no_length_or_hash(live, ctx, av):
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    ctx.fire("pre_llm_call", session_id=SESSION, turn_id="t0",
             user_message=[{"type": "text", "text": "private words"}])
    payload = messages(av, live, "message.in")[0]["payload"]
    assert payload["length"] is None and payload["content_hash"] is None
    assert "private words" not in json.dumps(av.read_buffer(live._COLLECTOR))


def test_an_empty_message_emits_nothing(live, ctx, av):
    ctx.fire("pre_llm_call", session_id=SESSION, turn_id="t0", user_message="")
    ctx.fire("post_llm_call", session_id=SESSION, turn_id="t0", assistant_response=None)
    assert messages(av, live) == []


def test_no_token_means_no_messages(plugin, ctx, av):
    plugin.register(ctx)
    converse(ctx)
    assert av.read_buffer(plugin._COLLECTOR) == []


def test_disabling_the_llm_hooks_disables_messages(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "pre_llm_call,post_llm_call")
    plugin.register(ctx)
    converse(ctx)
    assert messages(av, plugin) == []


def test_a_failing_message_builder_fails_open(live, ctx, av, monkeypatch):
    monkeypatch.setattr(live, "message_payload", lambda *a, **k: 1 / 0)
    assert ctx.fire("pre_llm_call", session_id=SESSION, turn_id="t0", user_message="hi") == []
    assert live._COLLECTOR.total_failures == 1
    assert messages(av, live) == []
