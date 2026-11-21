"""HOT-RASOOL-2: the mixed-provider reasoning heal (`_heal_reasoning.py`), dark behind AV_HEAL_REASONING_HISTORY.

Hermes is not imported. The three seams are driven the way Hermes v2026.9.24 drives them: the
`llm_request` middleware per attempt, `transform_api_error_classification` on the failed attempt (same
thread), and `pre_gateway_dispatch` on the next inbound message. `run_turn` below is a small model of
the retry loop's relevant branch (agent/turn_api_error.py:130-134 -> agent/turn_recovery.py:495-507,
then the format_error fallback), so the retry-once cap is tested end to end. One parse-only test pins
those seams in real Hermes source when AV_HERMES_TEST_DIR names a checkout (it skips in CI).

Synthetic fixtures only: no resident text, no real ids.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import logging
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

HAIKU = "anthropic/claude-haiku-4.5"
LUNA = "openai/gpt-6-luna"
SESSION = "20261026_000000_aaaaaaaa"
OTHER_SESSION = "20261026_000000_bbbbbbbb"
#: Synthetic stand-in for OpenRouter's refusal; only the fixed substring matters.
MIXED_400 = (
    "Error code: 400 - {'error': {'message': 'Provider returned error: the request contains Encrypted "
    "Reasoning or Compaction content from multiple providers, which cannot be combined. Start a new "
    "conversation.', 'code': 400}}"
)
SECRET_TEXT = "synthetic-resident-words-do-not-log"
LOG_LINE = re.compile(r"^av-events: heal_reasoning code=[a-z_]+( [a-z_]+=\d+)*$")


# ---- fixtures ---------------------------------------------------------------------------------------


@pytest.fixture()
def heal(plugin):
    module = sys.modules[f"{plugin.__name__}._heal_reasoning"]
    module.reset_state()
    yield module
    module.reset_state()


@pytest.fixture()
def on(monkeypatch):
    monkeypatch.setenv("AV_HEAL_REASONING_HISTORY", "1")


@pytest.fixture()
def mctx(ctx):
    """conftest's FakeCtx plus Hermes's `register_middleware` (hermes_cli/plugins.py:916)."""
    ctx.middleware = {}

    def register_middleware(kind: str, callback: Callable):
        ctx.middleware.setdefault(kind, []).append(callback)
        return object()

    ctx.register_middleware = register_middleware
    return ctx


def anthropic_details(n: int = 1) -> list[dict]:
    return [
        {"type": "reasoning.text", "text": f"synthetic thought {i}", "signature": f"sig-anthropic-{i}",
         "format": "anthropic-claude-v1", "index": i}
        for i in range(n)
    ]


def luna_details() -> list[dict]:
    return [
        {"type": "reasoning.summary", "summary": "synthetic summary", "format": "openai-responses-v1", "index": 0},
        {"type": "reasoning.encrypted", "data": "gAAAAsyntheticblob==", "format": "openai-responses-v1", "index": 1},
    ]


def mixed_history() -> list[dict]:
    """system, then a haiku turn with signed thinking, a luna fallback turn with encrypted reasoning, a new ask."""
    return [
        {"role": "system", "content": "synthetic system prompt"},
        {"role": "user", "content": "synthetic question one"},
        {"role": "assistant", "content": "synthetic answer one", "reasoning_details": anthropic_details()},
        {"role": "user", "content": "synthetic question two"},
        {"role": "assistant", "content": "synthetic answer two", "reasoning_details": luna_details()},
        {"role": "user", "content": "synthetic question three"},
    ]


def clean_history() -> list[dict]:
    return [
        {"role": "system", "content": "synthetic system prompt"},
        {"role": "user", "content": "synthetic question one"},
        {"role": "assistant", "content": "synthetic answer one", "reasoning_details": anthropic_details(2)},
        {"role": "user", "content": "synthetic question two"},
    ]


def middleware_call(heal, request: dict, *, session_id: str = SESSION, model: str = HAIKU) -> Optional[dict]:
    return heal.llm_request_middleware(
        request=copy.deepcopy(request), original_request=copy.deepcopy(request), session_id=session_id,
        model=model, provider="openrouter", base_url="https://openrouter.ai/api/v1", api_mode="chat_completions",
        task_id="t", turn_id="u", api_request_id="r", platform="telegram", api_call_count=1,
        telemetry_schema_version="hermes.observer.v1", middleware_schema_version="hermes.middleware.v1",
    )


def classify(heal, *, status: Any = 400, message: str = MIXED_400, model: str = HAIKU) -> Optional[dict]:
    return heal.classify_api_error(
        provider="openrouter", model=model, status_code=status, error_type="BadRequestError", error_code="",
        error_message=message.lower(), error_body={}, error=None, approx_tokens=1000, context_length=200000,
        num_messages=6, telemetry_schema_version="hermes.observer.v1",
    )


# ---- a small model of Hermes's retry branch ---------------------------------------------------------


class FakeOpenRouter:
    """400s a request whose reasoning_details carry two vendors' formats (or always, when `always_400`)."""

    def __init__(self, always_400: bool = False) -> None:
        self.always_400 = always_400
        self.calls: list[tuple[str, int]] = []

    def __call__(self, model: str, messages: list[dict]) -> str:
        formats = {
            str(d.get("format", "")).split("-", 1)[0]
            for m in messages if isinstance(m, dict)
            for d in (m.get("reasoning_details") or []) if isinstance(d, dict) and d.get("format")
        }
        self.calls.append((model, len(formats)))
        if self.always_400 or (model == HAIKU and len(formats) > 1):
            raise RuntimeError(MIXED_400)
        return f"answer from {model}"


def run_turn(heal, provider: FakeOpenRouter, history: list[dict], *, session_id: str = SESSION) -> dict:
    """One turn: build (middleware) -> call -> on the 400, classify (plugin first, else format_error) ->
    thinking_signature strips api_messages' reasoning_details and retries once (per turn) -> otherwise the
    fallback answers on luna. Returns what happened."""
    model = HAIKU
    api_messages = [dict(m) for m in history]
    thinking_sig_retry_attempted = False
    primary_calls = 0
    while True:
        request = {"model": model, "messages": api_messages}
        out = middleware_call(heal, request, session_id=session_id, model=model)
        if out is not None:
            request = copy.deepcopy(out["request"])
        try:
            if model == HAIKU:
                primary_calls += 1
            answer = provider(model, request["messages"])
            return {"answer": answer, "model": model, "primary_calls": primary_calls}
        except RuntimeError as exc:
            verdict = classify(heal, message=str(exc), model=model)
            reason = verdict["reason"] if verdict else "format_error"
            if reason == "thinking_signature" and not thinking_sig_retry_attempted:
                thinking_sig_retry_attempted = True
                for m in api_messages:
                    m.pop("reasoning_details", None)
                continue
            if model == LUNA:
                return {"answer": None, "model": model, "primary_calls": primary_calls}
            model = LUNA  # Hermes's fallback chain (format_error: retryable False, should_fallback True)


# ---- the switch -------------------------------------------------------------------------------------


def test_flag_off_registers_nothing(plugin, heal, mctx):
    ctx = mctx
    plugin.register(ctx)
    assert ctx.middleware == {}
    assert "transform_api_error_classification" not in ctx.hooks
    assert "pre_gateway_dispatch" not in ctx.hooks


def test_flag_on_registers_the_three_seams(plugin, heal, on, mctx):
    ctx = mctx
    plugin.register(ctx)
    assert ctx.middleware == {"llm_request": [heal.llm_request_middleware]}
    assert ctx.hooks["transform_api_error_classification"] == [heal.classify_api_error]
    assert ctx.hooks["pre_gateway_dispatch"] == [heal.pre_gateway_dispatch]


def test_flag_on_without_middleware_seam_registers_nothing(plugin, heal, on, ctx):
    # conftest's FakeCtx has no register_middleware: an older Hermes.
    plugin.register(ctx)
    assert "transform_api_error_classification" not in ctx.hooks
    assert heal.COUNTS.get("no_middleware_seam") == 1


def test_flag_read_from_dotenv(plugin, heal, home):
    (home / ".env").write_text("AV_HEAL_REASONING_HISTORY=on\n", encoding="utf-8")
    assert heal.enabled()


def test_flag_off_callbacks_are_no_ops_even_with_a_mark(heal, monkeypatch):
    monkeypatch.setenv("AV_HEAL_REASONING_HISTORY", "1")
    middleware_call(heal, {"messages": mixed_history()})
    assert classify(heal) is not None
    monkeypatch.setenv("AV_HEAL_REASONING_HISTORY", "0")
    assert middleware_call(heal, {"messages": mixed_history()}) is None
    assert classify(heal) is None
    assert heal.session_state(SESSION) == heal.STRIP  # untouched by the off calls


# ---- the strip --------------------------------------------------------------------------------------


def test_mixed_history_loses_only_the_foreign_entries(heal):
    history = mixed_history()
    before = copy.deepcopy(history)
    out, items, rows = heal.strip_foreign(history, HAIKU)
    assert (items, rows) == (2, 1)
    assert history == before  # the input (Hermes's copy) is never mutated
    assert out[2]["reasoning_details"] == anthropic_details()
    assert "reasoning_details" not in out[4]
    assert out[4]["content"] == "synthetic answer two"
    assert [m["content"] for m in out] == [m["content"] for m in before]


def test_on_the_fallback_model_the_other_side_is_foreign(heal):
    out, items, rows = heal.strip_foreign(mixed_history(), LUNA)
    assert (items, rows) == (1, 1)
    assert "reasoning_details" not in out[2]
    assert out[4]["reasoning_details"] == luna_details()


def test_clean_history_is_returned_untouched(heal):
    history = clean_history()
    out, items, rows = heal.strip_foreign(history, HAIKU)
    assert out is history and (items, rows) == (0, 0)


def test_unformatted_entries(heal):
    blob = {"type": "reasoning.encrypted", "data": "opaque"}
    text = {"type": "reasoning.text", "text": "plain"}
    history = [{"role": "assistant", "content": "a", "reasoning_details": [blob, text]}]
    out, items, _ = heal.strip_foreign(history, HAIKU)
    assert items == 1 and out[0]["reasoning_details"] == [text]


def test_vendor_spellings(heal):
    assert heal.is_foreign({"type": "reasoning.encrypted", "data": "x", "format": "xai-responses-v1"}, "xai") is False
    assert heal._vendor_of_model("x-ai/grok-5") == "xai"
    assert heal.is_foreign({"type": "reasoning.text", "text": "t", "format": "unknown"}, "anthropic") is False
    assert heal.is_foreign({"type": "reasoning.text", "signature": "s", "format": "unknown"}, "anthropic") is True
    # No vendor (a bare model id): every opaque entry goes, plain text stays.
    assert heal.is_foreign({"type": "reasoning.text", "signature": "s", "format": "anthropic-claude-v1"}, "") is True
    assert heal.is_foreign({"type": "reasoning.summary", "summary": "s"}, "") is False


def test_middleware_leaves_an_unmarked_session_alone(heal, on):
    assert middleware_call(heal, {"model": HAIKU, "messages": mixed_history()}) is None


def test_middleware_strips_a_marked_session_only(heal, on):
    middleware_call(heal, {"messages": mixed_history()})
    assert classify(heal)["reason"] == "thinking_signature"
    out = middleware_call(heal, {"model": HAIKU, "messages": mixed_history(), "stream": True})
    assert out is not None and out["request"]["stream"] is True and out["request"]["model"] == HAIKU
    assert "reasoning_details" not in out["request"]["messages"][4]
    assert middleware_call(heal, {"messages": mixed_history()}, session_id=OTHER_SESSION) is None
    # A marked session with nothing foreign left: no rewrite.
    assert middleware_call(heal, {"messages": clean_history()}) is None


def test_middleware_ignores_a_request_without_messages(heal, on):
    middleware_call(heal, {"messages": mixed_history()})
    classify(heal)
    assert middleware_call(heal, {"input": [{"type": "message"}]}) is None


# ---- the classification -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status,message",
    [
        (400, "error code: 400 - invalid request: messages[3] malformed"),
        (400, "thinking block signature invalid"),
        (500, MIXED_400),
        (429, MIXED_400),
        ("400", MIXED_400),
        (True, MIXED_400),
        (None, MIXED_400),
    ],
)
def test_only_this_400_is_matched(heal, on, status, message):
    middleware_call(heal, {"messages": mixed_history()})
    assert classify(heal, status=status, message=message) is None
    assert heal.session_state(SESSION) is None


def test_first_hit_retries_the_primary_once_then_hermes_as_before(heal, on):
    middleware_call(heal, {"messages": mixed_history()})
    verdict = classify(heal)
    assert verdict["reason"] == "thinking_signature"
    assert verdict["retryable"] is False and verdict["should_fallback"] is True
    assert heal.session_state(SESSION) == heal.STRIP
    assert classify(heal) is None  # the repair did not help: Hermes's own format_error fallback
    assert heal.session_state(SESSION) == heal.FAILED
    assert classify(heal) is None
    assert heal.COUNTS == {"repair": 1, "repair_failed": 1, "still_failed": 1}


def test_no_attempt_on_this_thread_is_left_to_hermes(heal, on):
    assert classify(heal) is None
    assert heal.COUNTS == {"no_session": 1}


def test_attempt_context_is_per_thread(heal, on):
    worker = threading.Thread(target=middleware_call, args=(heal, {"messages": mixed_history()}))
    worker.start()
    worker.join()
    assert classify(heal) is None  # this thread never built an attempt
    assert heal.session_state(SESSION) is None


def test_a_different_model_on_the_thread_is_left_to_hermes(heal, on):
    middleware_call(heal, {"messages": mixed_history()}, model=HAIKU)
    assert classify(heal, model=LUNA) is None


# ---- the turn loop, end to end ----------------------------------------------------------------------


def test_poisoned_session_heals_in_turn_and_stays_on_the_primary(heal, on):
    provider = FakeOpenRouter()
    first = run_turn(heal, provider, mixed_history())
    assert first == {"answer": f"answer from {HAIKU}", "model": HAIKU, "primary_calls": 2}
    second = run_turn(heal, provider, mixed_history())  # the stored history is still mixed
    assert second == {"answer": f"answer from {HAIKU}", "model": HAIKU, "primary_calls": 1}
    assert [model for model, _ in provider.calls] == [HAIKU, HAIKU, HAIKU]
    assert heal.COUNTS["repair"] == 1


def test_flag_off_the_poisoned_session_falls_back_every_turn(heal):
    provider = FakeOpenRouter()
    for _ in range(2):
        assert run_turn(heal, provider, mixed_history())["model"] == LUNA
    assert [model for model, _ in provider.calls] == [HAIKU, LUNA, HAIKU, LUNA]
    assert heal.COUNTS == {}


def test_retry_once_cap_when_the_strip_does_not_help(heal, on):
    provider = FakeOpenRouter(always_400=True)
    first = run_turn(heal, provider, mixed_history())
    assert first["primary_calls"] == 2  # the 400, then exactly one repaired retry
    second = run_turn(heal, provider, mixed_history())
    assert second["primary_calls"] == 1  # never a second repair: straight to Hermes's fallback
    assert heal.COUNTS["repair"] == 1
    assert heal.session_state(SESSION) == heal.FAILED


def test_clean_session_never_touched(heal, on):
    provider = FakeOpenRouter()
    assert run_turn(heal, provider, clean_history()) == {
        "answer": f"answer from {HAIKU}", "model": HAIKU, "primary_calls": 1}
    assert heal.COUNTS == {}


# ---- the fresh session ------------------------------------------------------------------------------


@dataclasses.dataclass
class Source:
    chat_id: str = "chat-1"
    chat_type: str = "dm"
    platform: str = "telegram"


@dataclasses.dataclass
class Event:
    text: str
    source: Source = dataclasses.field(default_factory=Source)


class Adapter:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send(self, chat_id: str, content: str, **_: Any) -> None:
        self.sent.append((chat_id, content))


class Gateway:
    def __init__(self, store: "Store", fail: bool = False) -> None:
        self.store = store
        self.adapter = Adapter()
        self.resets: list[str] = []
        self.fail = fail

    def _session_key_for_source(self, source: Source) -> str:
        return f"agent:main:{source.platform}:{source.chat_type}:{source.chat_id}"

    async def _handle_reset_command(self, event: Event) -> str:
        if self.fail:
            raise RuntimeError("synthetic reset failure")
        self.resets.append(event.text)
        self.store.ids[self._session_key_for_source(event.source)] = "20261026_000001_cccccccc"
        return "fresh session header"

    def _delivery_adapter_for(self, source: Source) -> Adapter:
        return self.adapter


class Store:
    def __init__(self) -> None:
        self.ids: dict[str, str] = {"agent:main:telegram:dm:chat-1": SESSION}

    def peek_session_id(self, session_key: str) -> Optional[str]:
        return self.ids.get(session_key)


def dispatch(heal, gateway: Gateway, event: Event) -> Any:
    return asyncio.run(heal.pre_gateway_dispatch(
        event=event, gateway=gateway, session_store=gateway.store, telemetry_schema_version="hermes.observer.v1"))


def fail_session(heal) -> None:
    middleware_call(heal, {"messages": mixed_history()})
    classify(heal)
    classify(heal)
    assert heal.session_state(SESSION) == heal.FAILED


def test_failed_repair_starts_one_fresh_session_and_says_so_once(heal, on):
    fail_session(heal)
    gateway = Gateway(Store())
    event = Event(text="synthetic next message")
    assert dispatch(heal, gateway, event) is None  # the message itself is dispatched as usual
    assert gateway.resets == ["/new"]
    assert gateway.adapter.sent == [("chat-1", heal.RESIDENT_LINE)]
    assert event.text == "synthetic next message"
    assert dispatch(heal, gateway, Event(text="synthetic later message")) is None
    assert gateway.resets == ["/new"] and len(gateway.adapter.sent) == 1  # never per turn
    assert heal.COUNTS["fresh_session"] == 1


def test_resident_line_is_products(heal):
    assert heal.RESIDENT_LINE == (
        "My last chat got tangled on my side, so I've started a fresh one. Anything from before this "
        "message I may not remember; just tell me again if needed.")


def test_no_fresh_session_without_a_failed_repair(heal, on):
    middleware_call(heal, {"messages": mixed_history()})
    classify(heal)  # STRIP only: the repair is still standing
    gateway = Gateway(Store())
    dispatch(heal, gateway, Event(text="synthetic"))
    assert gateway.resets == [] and gateway.adapter.sent == []


def test_fresh_session_only_in_a_dm(heal, on):
    fail_session(heal)
    gateway = Gateway(Store())
    dispatch(heal, gateway, Event(text="synthetic", source=Source(chat_type="group")))
    assert gateway.resets == []
    assert heal.session_state(SESSION) == heal.FAILED


def test_a_residents_own_command_goes_through(heal, on):
    fail_session(heal)
    gateway = Gateway(Store())
    dispatch(heal, gateway, Event(text="/new"))
    assert gateway.resets == [] and gateway.adapter.sent == []
    assert heal.session_state(SESSION) is None


def test_fresh_session_flag_off_does_nothing(heal, monkeypatch):
    monkeypatch.setenv("AV_HEAL_REASONING_HISTORY", "1")
    fail_session(heal)
    monkeypatch.setenv("AV_HEAL_REASONING_HISTORY", "0")
    gateway = Gateway(Store())
    dispatch(heal, gateway, Event(text="synthetic"))
    assert gateway.resets == []


def test_fresh_session_failure_never_breaks_dispatch(heal, on):
    fail_session(heal)
    gateway = Gateway(Store(), fail=True)
    assert dispatch(heal, gateway, Event(text="synthetic")) is None
    assert gateway.adapter.sent == []
    assert heal.COUNTS["fresh_session_error"] == 1


def test_fresh_session_without_gateway_seams(heal, on):
    fail_session(heal)

    class Bare:
        store = Store()

    assert dispatch(heal, Bare(), Event(text="synthetic")) is None
    assert heal.COUNTS["fresh_session_unavailable"] == 1


# ---- logging ----------------------------------------------------------------------------------------


def test_logs_are_codes_and_counts_only(heal, on, caplog):
    caplog.set_level(logging.INFO, logger="av-events")
    history = mixed_history()
    history[-1]["content"] = SECRET_TEXT
    run_turn(heal, FakeOpenRouter(always_400=True), history)
    fail = Gateway(Store())
    dispatch(heal, fail, Event(text=SECRET_TEXT))
    lines = [r.getMessage() for r in caplog.records if "heal_reasoning" in r.getMessage()]
    assert lines and all(LOG_LINE.match(line) for line in lines), lines
    joined = "\n".join(r.getMessage() for r in caplog.records)
    for forbidden in (SECRET_TEXT, SESSION, "multiple providers", "chat-1"):
        assert forbidden not in joined


# ---- the real seams (parse-only; skips without a Hermes checkout) -----------------------------------


def _hermes_dir() -> Optional[Path]:
    raw = os.environ.get("AV_HERMES_TEST_DIR", "").strip()
    return Path(raw) if raw and Path(raw, "agent", "error_classifier.py").is_file() else None


@pytest.mark.skipif(_hermes_dir() is None, reason="AV_HERMES_TEST_DIR names no Hermes checkout")
def test_hermes_seams_at_the_pinned_ref():
    root = _hermes_dir()
    assert root is not None
    plugins = (root / "hermes_cli" / "plugins.py").read_text(encoding="utf-8")
    assert '"transform_api_error_classification"' in plugins and '"pre_gateway_dispatch"' in plugins
    assert "def register_middleware(self, kind: str, callback: Callable)" in plugins
    middleware = (root / "hermes_cli" / "middleware.py").read_text(encoding="utf-8")
    assert 'LLM_REQUEST_MIDDLEWARE = "llm_request"' in middleware
    classifier = (root / "agent" / "error_classifier.py").read_text(encoding="utf-8")
    assert 'thinking_signature = "thinking_signature"' in classifier
    # Hermes has no rule of its own for this wording yet; when it gains one, retire this module.
    assert "multiple providers" not in classifier
    stages = classifier[classifier.index("_STAGES: Sequence"):]
    assert stages.split("(", 1)[1].lstrip().startswith("_plugin_verdict")
    recovery = (root / "agent" / "turn_recovery.py").read_text(encoding="utf-8")
    assert "classified.reason == FailoverReason.thinking_signature and not _retry.thinking_sig_retry_attempted" in recovery
    assert 'if isinstance(_m, dict) and "reasoning_details" in _m:' in recovery
    transport = (root / "agent" / "transports" / "chat_completions.py").read_text(encoding="utf-8")
    assert 'base_url_host_matches(base_url, "openrouter.ai")' in transport
    request = (root / "agent" / "turn_api_request.py").read_text(encoding="utf-8")
    assert "session_id=agent.session_id or \"\", platform=agent.platform or \"\", model=agent.model" in request
    gateway = (root / "gateway" / "slash_commands_session.py").read_text(encoding="utf-8")
    assert "async def _handle_reset_command(self, event: MessageEvent)" in gateway
    session = (root / "gateway" / "session.py").read_text(encoding="utf-8")
    assert "def peek_session_id(self, session_key: str)" in session
    run = (root / "gateway" / "run.py").read_text(encoding="utf-8")
    assert "def _session_key_for_source(self, source: SessionSource) -> str:" in run
