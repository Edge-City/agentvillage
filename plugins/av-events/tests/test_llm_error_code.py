"""HOT-RASOOL F1: a failed `llm.call` carries `error_code` from a fixed list, never text;
`fallback_activated` marks the call Hermes's fallback chain answered; `village` is a listed tool."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SESSION = "sess-llm-err"
#: OpenRouter's message from CLAIMS L26001, with a prompt fragment after it.
MIXED = (
    "Error code: 400 - {'error': {'message': 'Your request contains encrypted reasoning or compaction "
    "content from multiple providers. No single provider can decrypt the mixed history. Start a new "
    "conversation without the encrypted items.', 'code': 400}} PROMPT-FRAGMENT-hunter2"
)
SECRET = "prompt text that must never leave: hunter2"

#: Hermes v2026.9.24 `FailoverReason` values, and the code each must give.
REASONS = {
    "auth": "auth",
    "auth_permanent": "auth",
    "billing": "billing",
    "rate_limit": "rate_limited",
    "upstream_rate_limit": "rate_limited",
    "upstream_blocked": "network",
    "overloaded": "server",
    "server_error": "server",
    "timeout": "timeout",
    "ssl_cert_verification": "network",
    "context_overflow": "context_overflow",
    "payload_too_large": "context_overflow",
    "image_too_large": "bad_request",
    "image_corrupt": "bad_request",
    "model_not_found": "model_not_found",
    "provider_policy_blocked": "content_policy",
    "content_policy_blocked": "content_policy",
    "model_entitlement": "auth",
    "incomplete_response": "invalid_response",
    "format_error": "bad_request",
    "role_alternation": "bad_request",
    "invalid_encrypted_content": "bad_request",
    "multimodal_tool_content_unsupported": "bad_request",
    "reasoning_mandatory": "bad_request",
    "thinking_signature": "bad_request",
    "long_context_tier": "bad_request",
    "oauth_long_context_beta_forbidden": "bad_request",
    "llama_cpp_grammar_pattern": "bad_request",
    "invalid_response": "invalid_response",
    "unknown": "other",
}


def errs(plugin):
    return sys.modules[f"{plugin.__name__}._llm_errors"]


def tools(plugin):
    return sys.modules[f"{plugin.__name__}._tools"]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="haiku", platform="telegram")
    return plugin


def fail(ctx, *, turn="t1", req="r1", model="anthropic/claude-haiku-5.5", reason="format_error",
         status=400, etype="BadRequestError", message=SECRET):
    ctx.fire("pre_api_request", session_id=SESSION, turn_id=turn, api_request_id=req, model=model,
             system_prompt="SP", tool_count=0, request={"method": "POST", "body": {}})
    ctx.fire("api_request_error", session_id=SESSION, turn_id=turn, api_request_id=req, model=model,
             provider="openrouter", api_duration=0.4, status_code=status, retryable=False, reason=reason,
             error={"type": etype, "message": message})


def ok(ctx, *, turn="t1", req="r2", model="openai/gpt-6-luna"):
    ctx.fire("pre_api_request", session_id=SESSION, turn_id=turn, api_request_id=req, model=model,
             system_prompt="SP", tool_count=0, request={"method": "POST", "body": {}})
    ctx.fire("post_api_request", session_id=SESSION, turn_id=turn, api_request_id=req, model=model,
             provider="openrouter", api_duration=1.0, finish_reason="stop",
             usage={"input_tokens": 10, "output_tokens": 5})


def llm_calls(av, plugin):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"]


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield str(k)
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)


# -- the mapping (pure) -----------------------------------------------------


@pytest.mark.parametrize("reason,code", sorted(REASONS.items()))
def test_every_hermes_reason_maps(plugin, reason, code):
    assert errs(plugin).failure_code(reason=reason) == code


@pytest.mark.parametrize("status,code", [
    (400, "bad_request"), (401, "auth"), (402, "billing"), (403, "auth"), (404, "model_not_found"),
    (408, "timeout"), (413, "context_overflow"), (422, "bad_request"), (429, "rate_limited"),
    (500, "server"), (502, "server"), (503, "server"), (529, "server"), ("429", "rate_limited"),
    (418, "other"), (True, "other"), (None, "other"),
])
def test_status_maps_when_hermes_gives_no_known_reason(plugin, status, code):
    assert errs(plugin).failure_code(reason="unknown", status_code=status) == code


@pytest.mark.parametrize("etype,code", [
    ("CancelledError", "cancelled"), ("KeyboardInterrupt", "cancelled"),
    ("APITimeoutError", "timeout"), ("ConnectTimeout", "timeout"), ("ReadTimeout", "timeout"),
    ("RateLimitError", "rate_limited"), ("AuthenticationError", "auth"), ("PermissionDeniedError", "auth"),
    ("NotFoundError", "model_not_found"), ("BadRequestError", "bad_request"),
    ("UnprocessableEntityError", "bad_request"), ("APIConnectionError", "network"),
    ("ConnectError", "network"), ("RemoteProtocolError", "network"), ("SSLError", "network"),
    ("InternalServerError", "server"), ("ServiceUnavailableError", "server"),
    ("InvalidAPIResponse", "invalid_response"), ("ContentPolicyBlocked", "content_policy"),
    ("ValueError", "other"), ("", "other"), (None, "other"),
])
def test_class_name_maps_when_there_is_no_reason_or_status(plugin, etype, code):
    assert errs(plugin).failure_code(error_type=etype) == code


def test_reason_wins_over_status_and_class(plugin):
    # Hermes reads a 400 with an overflow body as context_overflow; that verdict wins.
    assert errs(plugin).failure_code(reason="context_overflow", status_code=400, error_type="BadRequestError") == "context_overflow"


def test_the_mixed_provider_message_wins_over_everything(plugin):
    module = errs(plugin)
    assert module.failure_code(reason="format_error", status_code=400, error_type="BadRequestError", message=MIXED) == module.MIXED_PROVIDER_HISTORY
    assert module.failure_code(message=MIXED.upper()) == module.MIXED_PROVIDER_HISTORY
    # Near misses are plain bad requests.
    assert module.failure_code(reason="format_error", message="encrypted reasoning from one provider") == "bad_request"
    assert module.failure_code(reason="format_error", message={"text": MIXED}) == "bad_request"


def test_every_code_is_a_short_token_from_the_fixed_list(plugin):
    module = errs(plugin)
    assert len(set(module.ERROR_CODES)) == len(module.ERROR_CODES)
    assert module.FALLBACK_ACTIVATED not in module.FAILURE_CODES
    for code in module.ERROR_CODES:
        assert code.isidentifier() and code.islower() and len(code) <= 32
    for reason in REASONS:
        assert module.failure_code(reason=reason) in module.FAILURE_CODES


def test_the_readme_lists_every_code(plugin):
    readme = (Path(errs(plugin).__file__).parent / "README.md").read_text(encoding="utf-8")
    for code in errs(plugin).ERROR_CODES:
        assert f"`{code}`" in readme, code


# -- through the hooks ------------------------------------------------------


def test_the_openrouter_mixed_history_400_is_named_and_no_text_leaves(live, ctx, av):
    fail(ctx, message=MIXED)
    [event] = llm_calls(av, live)
    payload = event["payload"]
    assert payload["error_code"] == "mixed_provider_history"
    # Every existing field is kept.
    assert payload["finish_reason"] == "error"
    assert payload["error_type"] == "BadRequestError"
    assert payload["status_code"] == 400
    assert payload["retryable"] is False
    assert payload["input_tokens"] == 0
    assert payload["system_prompt_hash"]
    # No key or value anywhere in the event carries the message or any piece of it.
    for text in strings(event):
        assert "encrypted reasoning" not in text and "hunter2" not in text and "multiple providers" not in text
        assert text not in MIXED or len(text) < 12, text
    assert "decrypt" not in json.dumps(event)


@pytest.mark.parametrize("reason,status,etype,code", [
    ("format_error", 400, "BadRequestError", "bad_request"),
    ("rate_limit", 429, "RateLimitError", "rate_limited"),
    ("auth", 401, "AuthenticationError", "auth"),
    ("timeout", None, "APITimeoutError", "timeout"),
    ("server_error", 500, "InternalServerError", "server"),
    (None, None, "APIConnectionError", "network"),
    (None, None, "CancelledError", "cancelled"),
    ("unknown", None, "Weird", "other"),
])
def test_a_failed_call_carries_its_code_and_no_message(live, ctx, av, reason, status, etype, code):
    fail(ctx, reason=reason, status=status, etype=etype)
    [event] = llm_calls(av, live)
    assert event["payload"]["error_code"] == code
    assert not any("hunter2" in text for text in strings(event))


def test_a_successful_call_has_no_error_code(live, ctx, av):
    ok(ctx, model="anthropic/claude-haiku-5.5")
    [event] = llm_calls(av, live)
    assert "error_code" not in event["payload"]


def test_the_fallback_models_answer_in_the_same_turn_is_fallback_activated(live, ctx, av):
    fail(ctx, message=MIXED)
    ok(ctx)
    failed, answered = llm_calls(av, live)
    assert failed["payload"]["error_code"] == "mixed_provider_history"
    assert answered["payload"]["error_code"] == "fallback_activated"
    assert answered["payload"]["finish_reason"] == "stop"
    # Only that one call: the next one in the turn carries nothing.
    ok(ctx, req="r3")
    assert "error_code" not in llm_calls(av, live)[-1]["payload"]


def test_a_retry_on_the_same_model_is_not_a_fallback(live, ctx, av):
    fail(ctx, reason="rate_limit", status=429, etype="RateLimitError")
    ok(ctx, model="anthropic/claude-haiku-5.5")
    assert "error_code" not in llm_calls(av, live)[-1]["payload"]


def test_another_turn_on_another_model_is_not_a_fallback(live, ctx, av):
    fail(ctx, turn="t1")
    ok(ctx, turn="t2")
    assert "error_code" not in llm_calls(av, live)[-1]["payload"]


def test_a_failed_fallback_keeps_its_own_code_and_the_next_model_is_marked(live, ctx, av):
    fail(ctx, message=MIXED)
    fail(ctx, req="r2", model="openai/gpt-6-luna", reason="server_error", status=502, etype="APIStatusError")
    ok(ctx, req="r3", model="third/model")
    codes = [e["payload"].get("error_code") for e in llm_calls(av, live)]
    assert codes == ["mixed_provider_history", "server", "fallback_activated"]


# -- the village tool is listed ---------------------------------------------


def test_village_is_listed_under_its_own_category(plugin):
    module = tools(plugin)
    assert module.TOOL_CATEGORY_VERSION == "tool_categories_v4"
    assert module.TOOL_CATEGORIES["village"] == "village"
    assert module.tool_category("village") == "village"
    assert module.listed_tool_name("village") == "village"


def test_a_village_tool_call_leaves_by_name(live, ctx, av):
    ctx.fire("post_tool_call", session_id=SESSION, task_id="task-1", turn_id="t1", tool_name="village",
             args={"operation": "rolodex.search", "query": SECRET}, result='{"error": "invalid_arguments"}',
             tool_call_id="call-1", api_request_id="r1", duration_ms=40, status="error",
             error_type="invalid_arguments", error_message=SECRET)
    [event] = [e for e in av.read_buffer(live._COLLECTOR) if e["event_type"] == "tool.call"]
    payload = event["payload"]
    assert (payload["tool_name"], payload["tool_category"], payload["ok"]) == ("village", "village", False)
    assert payload["error_type"] == "invalid_arguments"
    assert payload["category_version"] == "tool_categories_v4"
    assert not any("hunter2" in text for text in strings(event))
