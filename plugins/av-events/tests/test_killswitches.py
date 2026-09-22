"""Kill switches, idling and the envelope (spec scenario 26, guardrails §2)."""

from __future__ import annotations

import re

SESSION = "sess-kill"


def _drive(ctx, session_id=SESSION):
    ctx.fire("on_session_start", session_id=session_id, model="m", platform="telegram")
    ctx.fire("pre_llm_call", session_id=session_id, turn_id="t0", user_message="hi")
    ctx.fire("pre_tool_call", session_id=session_id, tool_name="shell")
    ctx.fire("on_session_finalize", session_id=session_id)


# --------------------------------------------------------------------------
# Scenario 26 — AV_EVENTS_ENABLED
# --------------------------------------------------------------------------


def test_enabled_zero_emits_nothing(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    plugin.register(ctx)
    _drive(ctx)
    assert av.read_buffer(plugin._COLLECTOR) == []


def test_unsetting_the_switch_resumes_on_the_next_session(plugin, ctx, monkeypatch, av):
    """The switch is re-read at each session boundary, not only at load."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    plugin.register(ctx)
    _drive(ctx, "sess-off")
    assert av.read_buffer(plugin._COLLECTOR) == []

    monkeypatch.delenv("AV_EVENTS_ENABLED")
    _drive(ctx, "sess-on")
    assert "session.started" in av.types_of(av.read_buffer(plugin._COLLECTOR))


def test_the_switch_is_honoured_from_hermes_home_dotenv(plugin, ctx, home, av):
    """The control plane can flip a tenant by rewriting `$HERMES_HOME/.env`."""
    (home / ".env").write_text("AV_EVENTS_TOKEN=dotenv-token\nAV_EVENTS_ENABLED=0\n", encoding="utf-8")
    plugin.register(ctx)
    _drive(ctx)
    assert av.read_buffer(plugin._COLLECTOR) == []


# --------------------------------------------------------------------------
# AV_HOOKS_DISABLED
# --------------------------------------------------------------------------


def test_named_hooks_can_be_disabled_individually(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "on_session_start, pre_tool_call")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    assert av.read_buffer(plugin._COLLECTOR) == []

    # An undisabled hook still opens the session lazily. It carries no
    # `platform`, so `session.started` waits for a source (see test_review_findings).
    ctx.fire("pre_llm_call", session_id=SESSION, turn_id="t0", user_message="hi")
    assert SESSION in plugin._COLLECTOR.sessions
    assert av.read_buffer(plugin._COLLECTOR) == []

    ctx.fire("pre_tool_call", session_id=SESSION, tool_name="shell")
    assert plugin._COLLECTOR.sessions[SESSION].tool_call_count == 0


# --------------------------------------------------------------------------
# Idle without a token
# --------------------------------------------------------------------------


def test_missing_token_idles_the_plugin(plugin, ctx, home, av):
    """Hooks registered, nothing emitted, nothing buffered, no thread."""
    plugin.register(ctx)
    assert len(ctx.hooks) == len(plugin.HOOK_BODIES)
    _drive(ctx)
    collector = plugin._COLLECTOR
    assert collector.config.idle is True
    assert av.read_buffer(collector) == []
    assert collector._thread is None
    assert not (home / "av-events").exists()


def test_idling_still_counts_nothing_as_a_failure(plugin, ctx):
    plugin.register(ctx)
    _drive(ctx)
    assert plugin._COLLECTOR.total_failures == 0


# --------------------------------------------------------------------------
# Envelope
# --------------------------------------------------------------------------

ENVELOPE_FIELDS = {
    "event_id", "event_type", "schema_version", "occurred_at",
    "occurred_at_earliest", "occurred_at_latest", "emitted_at", "actor",
    "session_id", "turn_id", "run_id", "parent_run_id", "tool_call_id",
    "intention_id", "opportunity_id", "decision_id", "action_id", "outcome_id",
    "in_reply_to_event_id", "evidence_class", "model_id", "prompt_version",
    "skill_version", "overlay_ref", "hermes_version", "policy_version",
    "supersedes_event_id", "payload",
}

UUID7_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def test_every_envelope_field_is_present(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    _drive(ctx)
    events = av.read_buffer(plugin._COLLECTOR)
    assert events
    for event in events:
        assert set(event) == ENVELOPE_FIELDS, event["event_type"]


def test_event_ids_are_uuid_v7_and_sort_by_emission(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    for index in range(12):
        ctx.fire("on_session_start", session_id=f"s{index}", model="m", platform="cli")
    ids = [event["event_id"] for event in av.read_buffer(plugin._COLLECTOR)]
    assert len(ids) == 12
    for value in ids:
        assert UUID7_RE.match(value), value
    assert ids == sorted(ids), "uuid v7 must sort in emission order"


def test_everything_this_plugin_emits_is_agent_report(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    _drive(ctx)
    for event in av.read_buffer(plugin._COLLECTOR):
        assert event["evidence_class"] == "agent_report"


def test_hermes_and_overlay_refs_are_null_when_undiscoverable(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    _drive(ctx)
    event = av.read_buffer(plugin._COLLECTOR)[0]
    # Hermes is not importable here, and it has no runtime overlay identifier
    # at v2026.8.31 at all (see README) — both fall back to null.
    assert event["overlay_ref"] is None
    assert event["hermes_version"] is None


def test_refs_are_populated_from_the_environment(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("HERMES_VERSION", "0.21.0")
    monkeypatch.setenv("OVERLAY_REF", "abc1234")
    plugin.register(ctx)
    _drive(ctx)
    event = av.read_buffer(plugin._COLLECTOR)[0]
    assert event["hermes_version"] == "0.21.0"
    assert event["overlay_ref"] == "abc1234"


def test_session_lifecycle_events_carry_the_catalogue_payload(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    ctx.fire("pre_llm_call", session_id=SESSION, turn_id="t0", user_message="hi")
    ctx.fire("pre_tool_call", session_id=SESSION, tool_name="shell")
    ctx.fire("post_llm_call", session_id=SESSION, turn_id="t0", assistant_response="ok")
    ctx.fire("on_session_finalize", session_id=SESSION)

    events = {e["event_type"]: e for e in av.read_buffer(plugin._COLLECTOR)}
    assert events["session.started"]["payload"]["source"] == "telegram"
    ended = events["session.ended"]["payload"]
    assert ended["source"] == "telegram"
    assert ended["message_count"] == 2
    assert ended["tool_call_count"] == 1
    assert ended["input_tokens"] == 0
    assert ended["output_tokens"] == 0


def test_on_session_end_does_not_end_the_session(plugin, ctx, monkeypatch, av):
    """It fires once per turn (turn_finalizer.py:828), so it must not close one."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    for turn in range(3):
        ctx.fire("on_session_end", session_id=SESSION, turn_id=f"t{turn}", completed=True)
    assert "session.ended" not in av.types_of(av.read_buffer(plugin._COLLECTOR))

    ctx.fire("on_session_finalize", session_id=SESSION)
    assert av.types_of(av.read_buffer(plugin._COLLECTOR)).count("session.ended") == 1
