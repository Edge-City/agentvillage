"""Hashing, sanitisation and the three capture modes (spec §7.1)."""

from __future__ import annotations

import json

SESSION = "sess-cap"

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "create_intent",
            "description": "Record an intention",
            "parameters": {"type": "object", "properties": {"text": {"type": "string"}}},
        },
    },
    {
        "type": "function",
        "function": {"name": "send_message", "description": "Reply", "parameters": {}},
    },
]

SYSTEM_PROMPT = "You are an Agent Village resident agent. Be useful."
SECRET_MESSAGE = "my key is sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ do not share"


def reorder(obj):
    """Same data, different key insertion order, recursively."""
    if isinstance(obj, dict):
        return {key: reorder(obj[key]) for key in reversed(list(obj))}
    if isinstance(obj, list):
        return [reorder(item) for item in obj]
    return obj


def fire_api_call(
    ctx, *, tools=TOOLS, system_prompt=SYSTEM_PROMPT, request_id="r0", usage=None, session=SESSION
):
    ctx.fire(
        "pre_api_request",
        session_id=session,
        turn_id="t0",
        task_id="task-0",
        api_request_id=request_id,
        model="anthropic/claude-sonnet-4-6",
        provider="openrouter",
        system_prompt=system_prompt,
        tool_count=len(tools or []),
        approx_input_tokens=1234,
        request={"method": "POST", "body": {"model": "m", "tools": tools, "messages": []}},
    )
    ctx.fire(
        "post_api_request",
        session_id=session,
        turn_id="t0",
        task_id="task-0",
        api_request_id=request_id,
        model="anthropic/claude-sonnet-4-6",
        provider="openrouter",
        api_mode="anthropic_messages",
        response_model="claude-sonnet-4-6",
        api_duration=1.25,
        finish_reason="stop",
        message_count=4,
        assistant_content_chars=1200,
        assistant_tool_call_count=1,
        usage=usage
        if usage is not None
        else {
            "input_tokens": 2048,
            "output_tokens": 512,
            "cache_read_tokens": 100,
            "cache_write_tokens": 7,
            "reasoning_tokens": 64,
        },
    )


# --------------------------------------------------------------------------
# Hash determinism
# --------------------------------------------------------------------------


def test_key_order_does_not_change_the_hash(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)

    fire_api_call(ctx, request_id="r0")
    fire_api_call(ctx, tools=reorder(TOOLS), request_id="r1")

    calls = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"]
    assert len(calls) == 2
    assert calls[0]["payload"]["tools_hash"] == calls[1]["payload"]["tools_hash"]
    # The reordering really did change the serialisation it was hashed from.
    assert json.dumps(reorder(TOOLS)) != json.dumps(TOOLS)


def test_a_changed_tool_changes_the_hash(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)

    changed = json.loads(json.dumps(TOOLS))
    changed[0]["function"]["description"] = "Record an intention (v2)"

    fire_api_call(ctx, request_id="r0")
    fire_api_call(ctx, tools=changed, request_id="r1")

    calls = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"]
    assert calls[0]["payload"]["tools_hash"] != calls[1]["payload"]["tools_hash"]


def test_a_changed_system_prompt_changes_its_hash(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    fire_api_call(ctx, request_id="r0")
    fire_api_call(ctx, system_prompt=SYSTEM_PROMPT + " Also be brief.", request_id="r1")
    calls = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"]
    assert calls[0]["payload"]["system_prompt_hash"] != calls[1]["payload"]["system_prompt_hash"]


def test_hashes_are_sha256_hex(plugin, ctx, monkeypatch, av):
    import hashlib

    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    fire_api_call(ctx)
    payload = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"][0]["payload"]
    expected = hashlib.sha256(
        json.dumps(TOOLS, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    assert payload["tools_hash"] == expected
    assert payload["system_prompt_hash"] == hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()


# --------------------------------------------------------------------------
# llm.call payload
# --------------------------------------------------------------------------


def test_llm_call_carries_the_catalogue_payload(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    fire_api_call(ctx)
    event = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"][0]
    payload = event["payload"]
    for field in (
        "model", "provider", "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_write_tokens", "reasoning_tokens", "latency_ms", "finish_reason",
        "tools_hash", "system_prompt_hash",
    ):
        assert field in payload, field
    assert payload["input_tokens"] == 2048
    assert payload["output_tokens"] == 512
    assert payload["cache_read_tokens"] == 100
    assert payload["latency_ms"] == 1250
    assert payload["provider"] == "openrouter"
    assert event["model_id"] == "anthropic/claude-sonnet-4-6"
    assert event["turn_id"] == "t0"
    assert event["run_id"] == "task-0"


def test_token_counts_accumulate_onto_session_ended(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    fire_api_call(ctx, request_id="r0")
    fire_api_call(ctx, request_id="r1")
    ctx.fire("on_session_finalize", session_id=SESSION)
    ended = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "session.ended"][0]
    assert ended["payload"]["input_tokens"] == 4096
    assert ended["payload"]["output_tokens"] == 1024


def test_a_response_without_usage_is_not_an_error(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    fire_api_call(ctx, usage={})
    payload = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"][0]["payload"]
    assert payload["input_tokens"] == 0
    assert plugin._COLLECTOR.total_failures == 0


# --------------------------------------------------------------------------
# sanitized (default)
# --------------------------------------------------------------------------


def test_sanitized_is_the_default(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    assert plugin._COLLECTOR.config.capture == "sanitized"


def test_an_unknown_capture_mode_falls_back_to_sanitized(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "everything")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    assert plugin._COLLECTOR.config.capture == "sanitized"


def test_sanitized_leaks_no_message_text(plugin, ctx, monkeypatch, av, home):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    ctx.fire("pre_llm_call", session_id=SESSION, turn_id="t0", user_message=SECRET_MESSAGE,
             conversation_history=[{"role": "user", "content": SECRET_MESSAGE}])
    fire_api_call(ctx)
    ctx.fire("pre_tool_call", session_id=SESSION, tool_name="shell",
             args={"command": "cat /etc/passwd"}, tool_call_id="tc0")
    ctx.fire("post_tool_call", session_id=SESSION, tool_name="shell",
             result="root:x:0:0", tool_call_id="tc0")
    ctx.fire("post_llm_call", session_id=SESSION, turn_id="t0", assistant_response=SECRET_MESSAGE)
    ctx.fire("on_session_finalize", session_id=SESSION)

    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    for leak in ("my key is", "do not share", "sk-ant-", "/etc/passwd", "root:x:0:0", SYSTEM_PROMPT):
        assert leak not in blob, leak
    # And nothing landed in the seen-set either.
    assert not (home / "av-events" / "seen.json").exists()


def test_sanitized_keeps_lengths_and_hashes(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    fire_api_call(ctx)
    payload = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"][0]["payload"]
    assert payload["system_prompt_length"] == len(SYSTEM_PROMPT)
    assert payload["assistant_content_chars"] == 1200
    assert len(payload["tools_hash"]) == 64


def test_metadata_mode_drops_the_lengths(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    fire_api_call(ctx)
    payload = [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"][0]["payload"]
    assert "system_prompt_length" not in payload
    assert "assistant_content_chars" not in payload
    # Configuration hashes stay: they describe the agent, not the participant.
    assert payload["tools_hash"]


# --------------------------------------------------------------------------
# full
# --------------------------------------------------------------------------


def test_full_emits_prompt_registered_once_per_hash_across_sessions(plugin, ctx, monkeypatch, av, home):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)

    def registered(collector):
        return [e for e in av.read_buffer(collector) if e["event_type"] == "prompt.registered"]

    fire_api_call(ctx, request_id="r0", session="sess-a")
    fire_api_call(ctx, request_id="r1", session="sess-a")
    first = registered(plugin._COLLECTOR)
    assert sorted(e["payload"]["kind"] for e in first) == ["system_prompt", "tools"]
    assert (home / "av-events" / "seen.json").exists()

    # A second session in a fresh load of the plugin: the seen-set is on disk,
    # so the same bytes must not register again. The buffer is shared, so count
    # across the whole of it rather than only the new events.
    module = av.load_plugin()
    module._COLLECTOR = None
    ctx2 = type(ctx)()
    module.register(ctx2)
    try:
        fire_api_call(ctx2, request_id="r2", session="sess-b")
        assert len(registered(module._COLLECTOR)) == len(first)
    finally:
        module._COLLECTOR = None


def test_full_carries_the_actual_bodies(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    fire_api_call(ctx)
    registered = {
        e["payload"]["kind"]: e["payload"]
        for e in av.read_buffer(plugin._COLLECTOR)
        if e["event_type"] == "prompt.registered"
    }
    assert registered["tools"]["body"] == TOOLS
    assert registered["system_prompt"]["body"] == SYSTEM_PROMPT
    assert len(registered["tools"]["hash"]) == 64


def test_full_still_redacts_a_secret_in_the_system_prompt(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    fire_api_call(ctx, system_prompt=f"Your bot token is 123456789:AA{'B' * 30}. Keep it safe.")
    body = [
        e["payload"]["body"]
        for e in av.read_buffer(plugin._COLLECTOR)
        if e["event_type"] == "prompt.registered" and e["payload"]["kind"] == "system_prompt"
    ][0]
    assert "[redacted:telegram_bot_token]" in body


# --------------------------------------------------------------------------
# Sanitiser and allowlist units
# --------------------------------------------------------------------------


def test_secret_shapes_are_redacted(plugin):
    sanitize = plugin.sanitize
    cases = {
        f"sk-ant-api03-{'A' * 40}": "anthropic_key",
        f"sk-or-v1-{'b' * 40}": "openrouter_key",
        f"sk-proj-{'C' * 40}": "openai_key",
        f"Bearer {'d' * 40}": "bearer",
        f"987654321:AA{'E' * 30}": "telegram_bot_token",
    }
    for raw, label in cases.items():
        cleaned = sanitize(f"prefix {raw} suffix")
        assert f"[redacted:{label}]" in cleaned, (raw, cleaned)
        assert raw not in cleaned


def test_the_sanitiser_walks_containers(plugin):
    payload = {"a": [f"sk-ant-{'A' * 30}"], "b": {"c": f"Bearer {'z' * 20}"}}
    cleaned = plugin.sanitize(payload)
    assert "sk-ant-" not in json.dumps(cleaned)
    assert "Bearer z" not in json.dumps(cleaned)


def test_our_own_token_never_leaves(plugin, ctx, monkeypatch, av):
    """A token echoed into a prompt is still a leak."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "av-tok-super-secret-value")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="cli")
    fire_api_call(ctx, system_prompt="ingest token is av-tok-super-secret-value ok")
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    assert "av-tok-super-secret-value" not in blob
    assert "[redacted:token]" in blob


def test_tool_categories_have_a_fallback(plugin):
    assert plugin.tool_category("create_intent") == "intention"
    assert plugin.tool_category("some_random_mcp_tool") == plugin.UNLISTED_TOOL_CATEGORY
    assert plugin.tool_category(None) == plugin.UNLISTED_TOOL_CATEGORY
