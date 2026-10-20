"""MM-INFER-VIS: the MoralMod negotiator's model steps as `llm.call` (caller moralmod_negotiator).

The Index plugin is never imported or executed here. `SPEAKER_SOURCE` is a stand-in with the
shape of `speaker.py` at the pinned `INDEX_PLUGIN_REF` (04d833b8): `_main_agent()` builds one
dedicated agent and caches it in the module global `_main`; `complete()` reads `_main_agent`
through that global and calls `agent.client.chat.completions.create(**kwargs)` itself. The
bridge's binding (`from .speaker import complete as complete_turn`) is mimicked by taking
`complete` before the plugin is registered. The client is a stand-in whose class says it comes
from the `openai` package, as `openai.OpenAI` does (`type(client).__module__ == "openai"`).
Synthetic text only.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

CONTRACT = json.loads((Path(__file__).parent / "vectors" / "negotiator_llm_contract.json").read_text(encoding="utf-8"))
SPEAKER_NAME = "hermes_plugins.index_network.speaker"
INDEX_PACKAGE = "hermes_plugins.index_network"

SECRET_SYSTEM = "Current intent: find-a-cofounder-for-secret-project\nIntent id: 7d1e"
SECRET_USER = "This negotiation:\n{\"id\": \"opp-1\", \"counterpart\": \"Alice Example\"}"
SECRET_TOOL = "propose_meeting_with_alice"
SECRET_REPLY = "Alice Example would love to meet at 12 Example Road"
LEAKS = ("secret-project", "Alice Example", "Example Road", SECRET_TOOL, "cofounder", "opp-1", "7d1e")

TENANT_KEY = "sk-or-v1-" + "a" * 64
MORALMOD_KEY = "sk-or-v1-" + "b" * 64
MORALMOD_KEY_2 = "sk-or-v1-" + "c" * 64

SPEAKER_SOURCE = '''
_main = None
BUILD = None

def _main_agent():
    global _main
    if _main is not None and getattr(_main, "client", None) is not None:
        return _main
    agent = BUILD()
    if getattr(agent, "client", None) is None:
        raise RuntimeError("Hermes has no model client configured.")
    _main = agent
    return agent

def complete(payload):
    agent = _main_agent()
    kwargs = {"model": agent.model, "messages": payload.get("messages") or []}
    tools = payload.get("tools") or None
    if tools:
        kwargs["tools"] = tools
        if payload.get("tool_choice"):
            kwargs["tool_choice"] = payload["tool_choice"]
    response = agent.client.chat.completions.create(**kwargs)
    choices = getattr(response, "choices", None) or []
    if not choices:
        raise RuntimeError("Hermes returned no completion.")
    message = choices[0].message
    return {"role": "assistant", "content": message.content, "tool_calls": len(message.tool_calls or [])}
'''


# --------------------------------------------------------------------------
# Stand-ins
# --------------------------------------------------------------------------


class Completions:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.calls = []

    def create(self, *args, **kwargs):
        self.calls.append(kwargs)
        return self.behaviour(kwargs)


class Chat:
    def __init__(self, behaviour):
        self.completions = Completions(behaviour)


class FakeOpenAI:
    def __init__(self, behaviour, api_key=None):
        self.api_key = TENANT_KEY if api_key is None else api_key
        self.chat = Chat(behaviour)


FakeOpenAI.__module__ = "openai"


class NotOpenAI(FakeOpenAI):
    pass


NotOpenAI.__module__ = "agent.moa_loop"


class RateLimitError(Exception):
    status_code = 429


class WeirdProviderError(Exception):
    """An exception whose message carries resident text, as a provider dump can."""


def response(*, cost=0.0123, generation="gen-1760000000-abcDEF123", content=SECRET_REPLY, tool_calls=1,
             finish="tool_calls", model="openai/gpt-6-luna"):
    message = SimpleNamespace(content=content, tool_calls=[SimpleNamespace(id=f"c{i}") for i in range(tool_calls)])
    usage = SimpleNamespace(
        prompt_tokens=1200,
        completion_tokens=80,
        total_tokens=1280,
        prompt_tokens_details=SimpleNamespace(cached_tokens=200),
        completion_tokens_details=SimpleNamespace(reasoning_tokens=30),
        cost=cost,
    )
    return SimpleNamespace(id=generation, model=model, choices=[SimpleNamespace(finish_reason=finish, message=message)],
                           usage=usage)


class FakeAgent:
    """`AIAgent`'s surface the seam reads: model, provider, api_mode, base_url, client, the stored
    client kwargs and Hermes's own client factory (here: the same SDK stand-in, with the kwargs' key)."""

    def __init__(self, client, model="openai/gpt-6-luna", provider="openrouter", api_mode="chat_completions",
                 base_url="https://openrouter.ai/api/v1", behaviour=None):
        self.model, self.provider, self.api_mode, self.base_url = model, provider, api_mode, base_url
        self.client = client
        self.api_key = TENANT_KEY
        self._client_kwargs = {"api_key": TENANT_KEY, "base_url": base_url, "default_headers": {"X-Title": "Hermes"}}
        self.built = []
        self.behaviour = behaviour

    def _create_openai_client(self, client_kwargs, *, reason, shared):
        self.built.append((dict(client_kwargs), reason, shared))
        return FakeOpenAI(self.behaviour, api_key=client_kwargs["api_key"])


def agent(client, **kwargs):
    return FakeAgent(client, **kwargs)


PAYLOAD = {
    "messages": [{"role": "system", "content": SECRET_SYSTEM}, {"role": "user", "content": SECRET_USER}],
    "tools": [{"type": "function", "function": {"name": SECRET_TOOL, "description": "Alice Example"}}],
    "tool_choice": "auto",
}


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


def nl(plugin):
    return sys.modules[f"{plugin.__name__}._negotiator_llm"]


@pytest.fixture()
def speaker(monkeypatch, av):
    """The stand-in speaker under Hermes's name for the Index plugin, with the bridge's client,
    installed beside this av-events (`<home>/plugins/index-network/speaker.py`), as on a box."""
    package = types.ModuleType(INDEX_PACKAGE)
    package.__path__ = []  # type: ignore[attr-defined]
    module = types.ModuleType(SPEAKER_NAME)
    exec(compile(SPEAKER_SOURCE, "speaker_standin", "exec"), module.__dict__)
    module.__file__ = str(av.PLUGIN_DIR.parent / "index-network" / "speaker.py")
    state = SimpleNamespace(result=response(), error=None, builds=0)

    def behaviour(kwargs):
        if state.error is not None:
            raise state.error
        return state.result

    client = FakeOpenAI(behaviour)
    state.moralmod_calls = []
    state.moralmod_error = None

    def moralmod_behaviour(kwargs):
        state.moralmod_calls.append(kwargs)
        if state.moralmod_error is not None:
            raise state.moralmod_error
        return behaviour(kwargs)

    def build():
        state.builds += 1
        state.agent = agent(client, behaviour=moralmod_behaviour)
        return state.agent

    module.BUILD = build
    monkeypatch.setitem(sys.modules, INDEX_PACKAGE, package)
    monkeypatch.setitem(sys.modules, SPEAKER_NAME, module)
    state.module = module
    state.client = client
    state.original_main_agent = module._main_agent
    # bridge.py binds `complete` at import, before av-events can see the module.
    state.bridge_complete = module.complete
    return state


@pytest.fixture()
def token(monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")


@pytest.fixture()
def on(monkeypatch):
    monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM", "1")


@pytest.fixture()
def registered(plugin, ctx, token, monkeypatch):
    """Register with the poller slowed right down (the tests drive `install()` themselves)."""
    monkeypatch.setattr(nl(plugin), "FAST_S", 3600.0)
    monkeypatch.setattr(nl(plugin), "SLOW_S", 3600.0)
    yield plugin
    nl(plugin).stop()


def register(plugin, ctx):
    plugin.register(ctx)
    return plugin


def calls(av, plugin):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "llm.call"]


# --------------------------------------------------------------------------
# The switch
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "0", "off", "false", "enabled", "2"])
def test_flag_off_installs_nothing_and_sends_nothing(registered, ctx, av, speaker, monkeypatch, value):
    if value is not None:
        monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM", value)
    module = nl(registered)
    spied = []
    for name in ("install", "_wrap_client", "_wrap_main_agent", "_observe", "negotiator_llm_payload"):
        real = getattr(module, name)
        monkeypatch.setattr(module, name, lambda *a, _n=name, _r=real, **k: (spied.append(_n), _r(*a, **k))[1])
    register(registered, ctx)
    assert speaker.module._main_agent is speaker.original_main_agent
    for _ in range(3):
        assert speaker.bridge_complete(PAYLOAD)["content"] == SECRET_REPLY
    assert "create" not in vars(speaker.client.chat.completions)
    assert spied == []
    assert calls(av, registered) == []
    assert not [t for t in threading.enumerate() if t.name == "av-events-negotiator-llm" and t.is_alive()]


def test_flag_on_spellings_install(registered, ctx, speaker, monkeypatch):
    for value in ("1", "true", "YES", " on "):
        monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM", value)
        assert nl(registered).flag_on()


# --------------------------------------------------------------------------
# One llm.call per create, the exact keys, no text
# --------------------------------------------------------------------------


def test_one_llm_call_per_create_with_exactly_the_contract_keys(registered, ctx, av, speaker, on):
    register(registered, ctx)
    for _ in range(3):
        speaker.bridge_complete(PAYLOAD)
    events = calls(av, registered)
    assert len(events) == 3
    event = events[0]
    payload = event["payload"]
    assert list(payload) == list(CONTRACT["keys"]) + list(CONTRACT["above_metadata"])
    assert payload == {
        "model": "openai/gpt-6-luna",
        "provider": "openrouter",
        "input_tokens": 1000,
        "output_tokens": 80,
        "cache_read_tokens": 200,
        "cache_write_tokens": 0,
        "reasoning_tokens": 30,
        "latency_ms": payload["latency_ms"],
        "finish_reason": "tool_calls",
        "tools_hash": None,
        "system_prompt_hash": None,
        "api_mode": "chat_completions",
        "response_model": "openai/gpt-6-luna",
        "tool_count": 1,
        "message_count": 2,
        "cost_usd": 0.0123,
        "generation_id": "gen-1760000000-abcDEF123",
        "error_type": None,
        "status_code": None,
        "caller": "moralmod_negotiator",
        "key_source": "tenant",
        "consent_scope": "all",
        "assistant_content_chars": len(SECRET_REPLY),
        "assistant_tool_call_count": 1,
    }
    assert isinstance(payload["latency_ms"], int) and payload["latency_ms"] >= 0
    # The bridge has no session: none of the resident's ids, and no run.
    assert (event["session_id"], event["turn_id"], event["run_id"], event["tool_call_id"]) == (None, None, None, None)
    assert event["model_id"] == "openai/gpt-6-luna"
    assert event["actor"] == "agent" and event["evidence_class"] == "agent_report"
    assert event["occurred_at"] and event["occurred_at_earliest"] == event["occurred_at"] and event["occurred_at_latest"]
    # Hermes's own request path is not involved: no prompt.registered, no session.started.
    assert [e["event_type"] for e in av.read_buffer(registered._COLLECTOR)] == ["llm.call"] * 3


def test_no_message_tool_or_completion_text_appears_anywhere(registered, ctx, av, speaker, on):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    speaker.error = WeirdProviderError("provider dump: Alice Example secret-project Example Road")
    with pytest.raises(WeirdProviderError):
        speaker.bridge_complete(PAYLOAD)
    raw = json.dumps(av.read_buffer(registered._COLLECTOR))
    for leak in LEAKS:
        assert leak not in raw
    assert len(calls(av, registered)) == 2


def test_metadata_capture_drops_the_lengths(registered, ctx, av, speaker, on, monkeypatch):
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    (event,) = calls(av, registered)
    assert list(event["payload"]) == list(CONTRACT["keys"])


def test_no_tools_and_no_choices(registered, ctx, av, speaker, on):
    register(registered, ctx)
    speaker.result = SimpleNamespace(id="chatcmpl-1", model="x", choices=[], usage=None)
    with pytest.raises(RuntimeError, match="no completion"):
        speaker.bridge_complete({"messages": [{"role": "user", "content": SECRET_USER}]})
    (event,) = calls(av, registered)
    payload = event["payload"]
    assert payload["tool_count"] == 0 and payload["message_count"] == 1
    assert payload["finish_reason"] is None and payload["generation_id"] is None and payload["cost_usd"] is None
    assert payload["input_tokens"] == payload["output_tokens"] == 0


# --------------------------------------------------------------------------
# Identical result, identical exception
# --------------------------------------------------------------------------


def test_the_wrapped_create_returns_the_identical_object(registered, ctx, speaker, on):
    register(registered, ctx)
    bridge_agent = speaker.module._main_agent()
    sent = response()
    speaker.result = sent
    got = bridge_agent.client.chat.completions.create(model="m", messages=[{"role": "user", "content": "x"}])
    assert got is sent
    assert speaker.client.chat.completions.calls[-1] == {"model": "m", "messages": [{"role": "user", "content": "x"}]}


def test_the_wrapped_create_reraises_the_identical_exception(registered, ctx, av, speaker, on):
    register(registered, ctx)
    bridge_agent = speaker.module._main_agent()
    raised = RateLimitError("slow down")
    speaker.error = raised
    with pytest.raises(RateLimitError) as caught:
        bridge_agent.client.chat.completions.create(model="m", messages=[])
    assert caught.value is raised
    (event,) = calls(av, registered)
    payload = event["payload"]
    assert payload["finish_reason"] == "error"
    assert (payload["error_type"], payload["status_code"]) == ("RateLimitError", 429)
    assert payload["response_model"] is None and payload["generation_id"] is None and payload["cost_usd"] is None
    assert [payload[k] for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                                 "reasoning_tokens")] == [0, 0, 0, 0, 0]


def test_an_unlisted_exception_is_other_and_a_base_exception_is_not_observed(registered, ctx, av, speaker, on):
    register(registered, ctx)
    bridge_agent = speaker.module._main_agent()
    speaker.error = WeirdProviderError("x")
    with pytest.raises(WeirdProviderError):
        bridge_agent.client.chat.completions.create(model="m", messages=[])
    assert calls(av, registered)[-1]["payload"]["error_type"] == "other"
    stop = KeyboardInterrupt()
    speaker.error = stop
    with pytest.raises(KeyboardInterrupt) as caught:
        bridge_agent.client.chat.completions.create(model="m", messages=[])
    assert caught.value is stop
    assert len(calls(av, registered)) == 1


def test_the_plugins_main_agent_raising_passes_through_unchanged(registered, ctx, av, speaker, on):
    register(registered, ctx)
    raised = RuntimeError("Hermes has no gateway model configured.")

    def build():
        raise raised

    speaker.module.BUILD = build
    with pytest.raises(RuntimeError) as caught:
        speaker.bridge_complete(PAYLOAD)
    assert caught.value is raised
    assert calls(av, registered) == []


def test_the_step_result_is_the_same_with_and_without_the_observer(plugin, ctx, token, speaker, monkeypatch):
    without = speaker.bridge_complete(PAYLOAD)
    monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM", "1")
    monkeypatch.setattr(nl(plugin), "FAST_S", 3600.0)
    try:
        register(plugin, ctx)
        assert speaker.bridge_complete(PAYLOAD) == without
    finally:
        nl(plugin).stop()


# --------------------------------------------------------------------------
# Only the bridge's client
# --------------------------------------------------------------------------


def test_the_residents_chat_client_is_never_wrapped(registered, ctx, av, speaker, on):
    resident_client = FakeOpenAI(lambda kwargs: response())
    resident = agent(resident_client)
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    # The bridge's own client is wrapped, on its instance only.
    assert "create" in vars(speaker.client.chat.completions)
    # The resident's client (same SDK class, its own instance, as Hermes builds one per AIAgent) is not.
    assert "create" not in vars(resident_client.chat.completions)
    assert type(resident_client.chat.completions).create is Completions.create
    assert resident.client.chat.completions.create.__func__ is Completions.create
    before = len(calls(av, registered))
    resident.client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}])
    assert len(calls(av, registered)) == before
    # And no agent but the speaker's own is ever handed to the wrap.
    assert speaker.module._main is not resident


def test_a_client_that_is_not_the_openai_sdk_is_not_wrapped_and_is_counted(registered, ctx, av, speaker, on):
    other = NotOpenAI(lambda kwargs: response())
    speaker.module.BUILD = lambda: SimpleNamespace(model="m", provider="openrouter", api_mode=None, client=other)
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    speaker.module._main_agent()
    assert "create" not in vars(other.chat.completions)
    assert calls(av, registered) == []
    assert registered._COLLECTOR.counters["negotiator_llm_client_unsupported"] == 1


# --------------------------------------------------------------------------
# Idempotent
# --------------------------------------------------------------------------


def test_wrapping_twice_wraps_once(registered, ctx, av, speaker, on):
    register(registered, ctx)
    register(registered, ctx)  # a second register() is a no-op
    module = nl(registered)
    assert module.install() and module.install()
    wrapper = speaker.module._main_agent
    assert wrapper.__wrapped__ is speaker.original_main_agent
    for _ in range(4):
        speaker.module._main_agent()
    create = speaker.client.chat.completions.create
    assert getattr(create, "__wrapped__").__func__ is Completions.create  # the SDK's method, one layer
    speaker.bridge_complete(PAYLOAD)
    speaker.bridge_complete(PAYLOAD)
    assert len(calls(av, registered)) == 2
    assert speaker.builds == 1


def test_a_reloaded_av_events_rewraps_the_original_not_its_predecessor(registered, ctx, av, speaker, on):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    module = nl(registered)
    # A predecessor's wrappers: same mark name, another token.
    foreign = object()
    old_main = speaker.module._main_agent
    old_create = speaker.client.chat.completions.create
    setattr(old_main, module._MARK, foreign)
    setattr(old_create, module._MARK, foreign)
    assert module.install()
    assert speaker.module._main_agent.__wrapped__ is speaker.original_main_agent
    speaker.module._main_agent()
    assert speaker.client.chat.completions.create.__wrapped__.__func__ is Completions.create
    before = len(calls(av, registered))
    speaker.bridge_complete(PAYLOAD)
    assert len(calls(av, registered)) == before + 1


def test_a_rebuilt_bridge_client_is_wrapped_on_its_next_step(registered, ctx, av, speaker, on):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    fresh = FakeOpenAI(lambda kwargs: response())
    speaker.module._main.client = fresh  # Hermes rebuilt the client (credential rotation)
    speaker.bridge_complete(PAYLOAD)
    assert "create" in vars(fresh.chat.completions)
    assert len(calls(av, registered)) == 2


# --------------------------------------------------------------------------
# Failure isolation: a counter, never the breaker
# --------------------------------------------------------------------------


def test_a_builder_that_raises_n_times_leaves_the_step_and_the_breaker_alone(registered, ctx, av, speaker, on,
                                                                            monkeypatch):
    register(registered, ctx)
    expected = speaker.bridge_complete(PAYLOAD)
    module = nl(registered)

    def boom(**kwargs):
        raise RuntimeError("builder broke")

    monkeypatch.setattr(module, "negotiator_llm_payload", boom)
    for _ in range(25):
        assert speaker.bridge_complete(PAYLOAD) == expected
    collector = registered._COLLECTOR
    assert collector.counters["negotiator_llm_failed"] == 25
    assert collector.total_failures == 0 and not collector.plugin_disabled
    assert [e for e in av.read_buffer(collector) if e["event_type"] == "plugin.degraded"] == []
    assert len(calls(av, registered)) == 1
    # A failing emit is isolated the same way.
    monkeypatch.undo()
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM", "1")
    monkeypatch.setattr(collector, "emit", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    assert speaker.bridge_complete(PAYLOAD) == expected
    assert collector.counters["negotiator_llm_failed"] == 26


def test_a_failing_client_wrap_still_returns_the_agent(registered, ctx, av, speaker, on, monkeypatch):
    register(registered, ctx)
    module = nl(registered)

    def boom(agent):
        raise RuntimeError("wrap broke")

    monkeypatch.setattr(module, "_wrap_client", boom)
    result = speaker.bridge_complete(PAYLOAD)
    assert result["content"] == SECRET_REPLY
    assert registered._COLLECTOR.counters["negotiator_llm_failed"] == 1
    assert registered._COLLECTOR.total_failures == 0
    assert "create" not in vars(speaker.client.chat.completions)


# --------------------------------------------------------------------------
# Hermes or plugin drift: counted no-op
# --------------------------------------------------------------------------


@pytest.mark.parametrize("missing", ["_main_agent", "complete"])
def test_a_speaker_without_the_seam_is_a_counted_noop(registered, ctx, av, speaker, on, missing):
    delattr(speaker.module, missing)
    register(registered, ctx)
    module = nl(registered)
    assert module.install() is False and module.install() is False
    assert registered._COLLECTOR.counters["negotiator_llm_no_seam"] == 1
    if missing == "complete":
        assert speaker.module._main_agent is speaker.original_main_agent
    assert calls(av, registered) == []


def test_no_index_plugin_is_an_uncounted_noop(registered, ctx, on):
    register(registered, ctx)
    assert nl(registered).install() is False
    assert not any(k.startswith("negotiator_llm") for k in registered._COLLECTOR.counters)


def test_the_poller_finds_an_index_plugin_that_loads_after_av_events(plugin, ctx, token, on, speaker, monkeypatch, av):
    module = nl(plugin)
    monkeypatch.setattr(module, "FAST_S", 0.01)
    del sys.modules[SPEAKER_NAME]
    try:
        register(plugin, ctx)
        assert speaker.module._main_agent is speaker.original_main_agent
        sys.modules[SPEAKER_NAME] = speaker.module  # the Index plugin loads (sorted after av-events)
        deadline = time.monotonic() + 5
        while speaker.module._main_agent is speaker.original_main_agent and time.monotonic() < deadline:
            time.sleep(0.01)
        assert getattr(speaker.module._main_agent, module._MARK, None) is module._TOKEN
        speaker.bridge_complete(PAYLOAD)
        assert len(calls(av, plugin)) == 1
    finally:
        module.stop()


# --------------------------------------------------------------------------
# Switches that stop it live, and unload
# --------------------------------------------------------------------------


def test_turning_the_flag_off_stops_events_at_once(registered, ctx, av, speaker, on, monkeypatch):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM", "0")
    assert speaker.bridge_complete(PAYLOAD)["content"] == SECRET_REPLY
    assert len(calls(av, registered)) == 1


@pytest.mark.parametrize("env", [{"AV_HOOKS_DISABLED": "negotiator_llm"}, {"AV_EVENTS_ENABLED": "0"},
                                 {"AV_EVENTS_TOKEN": ""}])
def test_the_plugins_own_gates_hold(registered, ctx, av, speaker, on, monkeypatch, env):
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    assert calls(av, registered) == []


def test_unload_puts_everything_back(registered, ctx, av, speaker, on):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    assert "create" in vars(speaker.client.chat.completions)
    registered._on_unload()
    assert speaker.module._main_agent is speaker.original_main_agent
    assert "create" not in vars(speaker.client.chat.completions)
    assert speaker.bridge_complete(PAYLOAD)["content"] == SECRET_REPLY


def test_pre_tool_call_never_reaches_the_observer(plugin):
    assert "_negotiator_llm" not in plugin._hook_pre_tool_call.__code__.co_names


# --------------------------------------------------------------------------
# Values
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [(None, "all"), ("", "all"), ("  ", "all"), ("all", "all"), (" research_consented ", "research_consented"),
     ("research", "research_consented"), ("ALL", "research_consented")],
)
def test_scope_values(plugin, monkeypatch, value, expected):
    if value is not None:
        monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM_SCOPE", value)
    assert nl(plugin).scope() == expected


def test_an_unrecognised_scope_logs_the_variable_never_the_value(plugin, monkeypatch, caplog):
    monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM_SCOPE", "typo-value-xyz")
    with caplog.at_level(logging.WARNING, logger="av-events"):
        nl(plugin).scope()
        nl(plugin).scope()
    lines = [r.getMessage() for r in caplog.records if "NEGOTIATOR_LLM_SCOPE" in r.getMessage()]
    assert len(lines) == 1 and "typo-value-xyz" not in lines[0]


def test_scope_rides_in_the_payload(registered, ctx, av, speaker, on, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_NEGOTIATOR_LLM_SCOPE", "research_consented")
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    assert calls(av, registered)[0]["payload"]["consent_scope"] == "research_consented"


@pytest.mark.parametrize("cost,expected", [(0.0123, 0.0123), (0, 0.0), (None, None), (True, None), (-1, None),
                                           (float("inf"), None), (float("nan"), None), (100.5, None), ("0.1", None)])
def test_cost_is_a_finite_price_or_null(plugin, cost, expected):
    payload = nl(plugin).negotiator_llm_payload(model="m", provider="openrouter", api_mode="chat_completions",
                                                request={}, response=response(cost=cost), latency_ms=1,
                                                capture="sanitized", consent_scope="all")
    assert payload["cost_usd"] == expected


@pytest.mark.parametrize("value,expected", [("gen-1760000000-abc", "gen-1760000000-abc"), ("chatcmpl-1", None),
                                            ("gen-1\n", None), (None, None), ("gen-" + "a" * 125, None)])
def test_generation_id_is_openrouters_shape_or_null(plugin, value, expected):
    payload = nl(plugin).negotiator_llm_payload(model="m", provider="p", api_mode=None, request={},
                                                response=response(generation=value), latency_ms=1,
                                                capture="sanitized", consent_scope="all")
    assert payload["generation_id"] == expected


@pytest.mark.parametrize("finish,expected", [("stop", "stop"), ("length", "length"), ("weird", "other"), (None, None)])
def test_finish_reason_is_closed(plugin, finish, expected):
    payload = nl(plugin).negotiator_llm_payload(model="m", provider="p", api_mode=None, request={},
                                                response=response(finish=finish), latency_ms=1,
                                                capture="sanitized", consent_scope="all")
    assert payload["finish_reason"] == expected


def test_model_and_provider_off_their_shape_are_null(plugin):
    payload = nl(plugin).negotiator_llm_payload(model="Alice Example said hi", provider="Open Router!",
                                                api_mode="chat completions", request={},
                                                response=response(model="a\nb"), latency_ms=1,
                                                capture="sanitized", consent_scope="bogus")
    assert (payload["model"], payload["provider"], payload["api_mode"], payload["response_model"]) == (None,) * 4
    assert payload["consent_scope"] == "research_consented"


def test_hermes_normalize_usage_is_used_when_it_imports(plugin, monkeypatch):
    seen = {}

    def normalize_usage(usage, *, provider=None, api_mode=None):
        seen.update(provider=provider, api_mode=api_mode)
        return SimpleNamespace(input_tokens=7, output_tokens=6, cache_read_tokens=5, cache_write_tokens=4,
                               reasoning_tokens=3)

    pkg = types.ModuleType("agent")
    pkg.__path__ = []  # type: ignore[attr-defined]
    pricing = types.ModuleType("agent.usage_pricing")
    pricing.normalize_usage = normalize_usage
    monkeypatch.setitem(sys.modules, "agent", pkg)
    monkeypatch.setitem(sys.modules, "agent.usage_pricing", pricing)
    payload = nl(plugin).negotiator_llm_payload(model="m", provider="openrouter", api_mode="chat_completions",
                                                request={}, response=response(), latency_ms=1,
                                                capture="sanitized", consent_scope="all")
    assert [payload[k] for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                                 "reasoning_tokens")] == [7, 6, 5, 4, 3]
    assert seen == {"provider": "openrouter", "api_mode": "chat_completions"}


# --------------------------------------------------------------------------
# Manifest and contract
# --------------------------------------------------------------------------


def test_manifest_lists_both_variables(plugin):
    import yaml

    manifest = yaml.safe_load((Path(plugin.__file__).parent / "plugin.yaml").read_text(encoding="utf-8"))
    assert {"AV_EVENTS_NEGOTIATOR_LLM", "AV_EVENTS_NEGOTIATOR_LLM_SCOPE", "AV_MORALMOD_OWN_KEY",
            "MORALMOD_LLM_API_KEY"} <= set(manifest["optional_env"])


def test_contract_vector_matches_the_module(plugin):
    module = nl(plugin)
    assert CONTRACT["type"] == module.TYPE == "llm.call"
    assert CONTRACT["caller"] == module.CALLER
    assert CONTRACT["keys"] == list(module.KEYS)
    assert CONTRACT["above_metadata"] == list(module.ABOVE_METADATA)
    assert CONTRACT["switch"]["env"] == module.FLAG
    assert CONTRACT["scope_switch"]["env"] == module.SCOPE_ENV
    assert CONTRACT["scope_switch"]["values"] == list(module.SCOPES)
    assert CONTRACT["hooks_disabled_name"] == module.HOOK_NAME
    assert CONTRACT["fields"]["error_type"]["enum"] == list(module.ERROR_TYPES) + [module.ERROR_OTHER]
    assert CONTRACT["fields"]["finish_reason"]["enum"] == list(module.FINISH_REASONS) + [module.FINISH_OTHER,
                                                                                        module.FINISH_ERROR]
    assert CONTRACT["fields"]["caller"]["enum"] == [module.CALLER]
    assert CONTRACT["fields"]["key_source"]["enum"] == list(module.KEY_SOURCES)
    assert CONTRACT["own_key_switch"]["env"] == module.OWN_KEY_FLAG
    assert CONTRACT["own_key_switch"]["key_env"] == module.OWN_KEY_ENV
    assert CONTRACT["own_key_switch"]["key_shape"] == "^" + module._OWN_KEY_SHAPE.pattern + "$"
    assert CONTRACT["fields"]["generation_id"]["regex"] == "^" + module._GENERATION_ID_SHAPE.pattern + "$"
    assert CONTRACT["fields"]["model"]["regex"] == "^" + module._MODEL_SHAPE.pattern + "$"
    assert CONTRACT["fields"]["provider"]["regex"] == "^" + module._PROVIDER_SHAPE.pattern + "$"
    assert CONTRACT["fields"]["api_mode"]["regex"] == "^" + module._API_MODE_SHAPE.pattern + "$"
    assert CONTRACT["fields"]["cost_usd"]["range"][1] == module.COST_USD_MAX
    assert set(CONTRACT["fields"]) == set(module.KEYS) | set(module.ABOVE_METADATA)
    # Version 1: llm.call has no entry in `_core.SCHEMA_VERSIONS`.
    assert "llm.call" not in sys.modules[f"{plugin.__name__}._core"].SCHEMA_VERSIONS


# --------------------------------------------------------------------------
# The MoralMod key (AV_MORALMOD_OWN_KEY): the bridge's client only, never the resident's; with the
# switch on, the MoralMod key or a failed step, never the tenant's key (CLAIMS L13060)
# --------------------------------------------------------------------------


@pytest.fixture()
def own_key(monkeypatch):
    monkeypatch.setenv("AV_MORALMOD_OWN_KEY", "1")
    monkeypatch.setenv("MORALMOD_LLM_API_KEY", MORALMOD_KEY)


def unavailable(plugin):
    return nl(plugin).MoralmodKeyUnavailable


def test_own_key_off_keeps_the_tenants_client(registered, ctx, av, speaker, on):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    assert speaker.agent.client is speaker.client and speaker.agent.built == []
    assert calls(av, registered)[0]["payload"]["key_source"] == "tenant"


def test_own_key_builds_the_bridge_client_with_the_moralmod_key_only(registered, ctx, av, speaker, on, own_key):
    resident_client = FakeOpenAI(lambda kwargs: response())
    resident = agent(resident_client)
    register(registered, ctx)
    result = speaker.bridge_complete(PAYLOAD)
    bridge = speaker.agent
    assert result["content"] == SECRET_REPLY
    # One client built by Hermes's own factory, from a copy of the agent's kwargs with only the key changed.
    ((built_kwargs, reason, shared),) = bridge.built
    assert built_kwargs == {"api_key": MORALMOD_KEY, "base_url": "https://openrouter.ai/api/v1",
                            "default_headers": {"X-Title": "Hermes"}}
    assert (reason, shared) == ("av_moralmod_own_key", True)
    assert bridge.client is not speaker.client and bridge.client.api_key == MORALMOD_KEY
    # The step went out on the MoralMod client, not the tenant's.
    assert len(speaker.moralmod_calls) == 1 and speaker.client.chat.completions.calls == []
    # Nothing of the tenant's changed: the stored kwargs, the agent's key, the tenant client, the resident.
    assert bridge._client_kwargs["api_key"] == TENANT_KEY and bridge.api_key == TENANT_KEY
    assert speaker.client.api_key == TENANT_KEY
    assert resident.client is resident_client and resident_client.api_key == TENANT_KEY
    assert "create" not in vars(resident_client.chat.completions)
    (event,) = calls(av, registered)
    assert event["payload"]["key_source"] == "moralmod"
    # Built once per key, and metered before any step could see it (N3).
    assert "create" in vars(bridge.client.chat.completions)
    speaker.bridge_complete(PAYLOAD)
    assert len(bridge.built) == 1


def test_own_key_works_without_the_metering_switch(registered, ctx, av, speaker, own_key):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    assert speaker.agent.client.api_key == MORALMOD_KEY
    assert "create" not in vars(speaker.agent.client.chat.completions)
    assert calls(av, registered) == []


@pytest.mark.parametrize("value", [None, "", "not-a-key", "sk-ant-" + "a" * 40, MORALMOD_KEY + "\n x",
                                   "sk-or-" + "a" * 15])
def test_a_missing_or_malformed_key_fails_the_step_never_the_tenants_key(registered, ctx, av, speaker, on, monkeypatch,
                                                                       value):
    monkeypatch.setenv("AV_MORALMOD_OWN_KEY", "1")
    if value is not None:
        monkeypatch.setenv("MORALMOD_LLM_API_KEY", value)
    register(registered, ctx)
    with pytest.raises(unavailable(registered)) as caught:
        speaker.bridge_complete(PAYLOAD)
    assert str(caught.value) == "The MoralMod key is not available for this step."
    assert caught.value.__context__ is None and caught.value.__cause__ is None
    assert speaker.client.chat.completions.calls == [] and speaker.agent.built == []
    assert speaker.agent.client is speaker.client  # untouched, and never called
    collector = registered._COLLECTOR
    assert collector.counters["moralmod_key_missing"] == 1
    assert collector.total_failures == 0 and not collector.plugin_disabled
    assert calls(av, registered) == []  # no model call was made


@pytest.mark.parametrize("status", [401, 402])
def test_an_invalid_or_exhausted_key_fails_the_step_as_today_with_no_tenant_retry(registered, ctx, av, speaker, on,
                                                                                  own_key, status):
    class APIStatusError(Exception):
        pass

    raised = APIStatusError("Insufficient credits")
    raised.status_code = status
    speaker.moralmod_error = raised
    register(registered, ctx)
    with pytest.raises(APIStatusError) as caught:
        speaker.bridge_complete(PAYLOAD)
    assert caught.value is raised
    assert len(speaker.moralmod_calls) == 1
    assert speaker.client.chat.completions.calls == []  # never retried on the tenant's key
    payload = calls(av, registered)[0]["payload"]
    assert (payload["key_source"], payload["finish_reason"], payload["error_type"], payload["status_code"]) == (
        "moralmod", "error", "APIStatusError", status)


def test_switching_off_puts_the_tenant_client_back_and_removing_the_key_fails(registered, ctx, av, speaker, on,
                                                                             own_key, monkeypatch):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    assert speaker.agent.client.api_key == MORALMOD_KEY
    monkeypatch.setenv("AV_MORALMOD_OWN_KEY", "0")
    speaker.bridge_complete(PAYLOAD)
    assert speaker.agent.client is speaker.client
    monkeypatch.setenv("AV_MORALMOD_OWN_KEY", "1")
    speaker.bridge_complete(PAYLOAD)
    assert speaker.agent.client.api_key == MORALMOD_KEY
    monkeypatch.delenv("MORALMOD_LLM_API_KEY")
    tenant_calls = len(speaker.client.chat.completions.calls)
    with pytest.raises(unavailable(registered)):
        speaker.bridge_complete(PAYLOAD)
    assert len(speaker.client.chat.completions.calls) == tenant_calls
    assert [e["payload"]["key_source"] for e in calls(av, registered)] == ["moralmod", "tenant", "moralmod"]


def test_a_rotated_key_rebuilds_from_the_tenant_kwargs(registered, ctx, speaker, on, own_key, monkeypatch):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    monkeypatch.setenv("MORALMOD_LLM_API_KEY", MORALMOD_KEY_2)
    speaker.bridge_complete(PAYLOAD)
    assert speaker.agent.client.api_key == MORALMOD_KEY_2
    assert [b[0]["api_key"] for b in speaker.agent.built] == [MORALMOD_KEY, MORALMOD_KEY_2]


@pytest.mark.parametrize("base_url", ["https://api.openai.com/v1", "https://openrouter.ai.evil.example/v1", "",
                                      "http://openrouter.ai/api/v1"])
def test_a_base_url_that_is_not_openrouter_over_https_fails_the_step(registered, ctx, speaker, on, own_key, base_url):
    speaker.module.BUILD = lambda: agent(speaker.client, base_url=base_url)
    register(registered, ctx)
    with pytest.raises(unavailable(registered)):
        speaker.bridge_complete(PAYLOAD)
    bridge = speaker.module._main
    assert bridge.client is speaker.client and bridge.built == []
    assert speaker.client.chat.completions.calls == []
    counters = registered._COLLECTOR.counters
    assert counters["moralmod_key_failed"] == 1 and counters["moralmod_key_unsupported"] == 1


@pytest.mark.parametrize("header", ["Authorization", "authorization", "X-Api-Key"])
def test_a_custom_auth_header_that_would_beat_the_key_fails_the_step(registered, ctx, speaker, on, own_key, header):
    def build():
        a = agent(speaker.client)
        a._client_kwargs["default_headers"] = {header: "Bearer something"}
        return a

    speaker.module.BUILD = build
    register(registered, ctx)
    with pytest.raises(unavailable(registered)):
        speaker.bridge_complete(PAYLOAD)
    assert speaker.module._main.built == [] and speaker.client.chat.completions.calls == []


def test_a_hermes_without_the_factory_fails_the_step(registered, ctx, speaker, on, own_key):
    def build():
        a = agent(speaker.client)
        a._create_openai_client = None
        return a

    speaker.module.BUILD = build
    register(registered, ctx)
    with pytest.raises(unavailable(registered)):
        speaker.bridge_complete(PAYLOAD)
    assert speaker.module._main.client is speaker.client and speaker.client.chat.completions.calls == []
    assert registered._COLLECTOR.counters["moralmod_key_failed"] == 1


def test_a_factory_that_raises_fails_every_step_counted_and_never_chains_its_text(registered, ctx, speaker, on,
                                                                                   own_key):
    def boom(*a, **k):
        raise RuntimeError(f"factory broke near {MORALMOD_KEY}")

    speaker.module.BUILD = lambda: _with(agent(speaker.client), _create_openai_client=boom)
    register(registered, ctx)
    for _ in range(12):
        with pytest.raises(unavailable(registered)) as caught:
            speaker.bridge_complete(PAYLOAD)
        assert MORALMOD_KEY not in str(caught.value)
        assert caught.value.__context__ is None and caught.value.__cause__ is None
    assert speaker.module._main.client is speaker.client and speaker.client.chat.completions.calls == []
    collector = registered._COLLECTOR
    assert collector.counters["moralmod_key_failed"] == 12
    assert collector.total_failures == 0 and not collector.plugin_disabled


def test_a_factory_returning_another_key_fails_the_step(registered, ctx, speaker, on, own_key):
    def build():
        a = agent(speaker.client)
        a._create_openai_client = lambda kwargs, *, reason, shared: FakeOpenAI(lambda k: response(), api_key=TENANT_KEY)
        return a

    speaker.module.BUILD = build
    register(registered, ctx)
    with pytest.raises(unavailable(registered)):
        speaker.bridge_complete(PAYLOAD)
    assert speaker.client.chat.completions.calls == []


def _with(obj, **attrs):
    for name, value in attrs.items():
        setattr(obj, name, value)
    return obj


def test_two_first_steps_at_once_build_one_metered_client(registered, ctx, av, speaker, on, own_key):
    register(registered, ctx)
    results, errors = [], []

    def step():
        try:
            results.append(speaker.bridge_complete(PAYLOAD))
        except Exception as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=step) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == [] and len(results) == 16
    assert len(speaker.agent.built) == 1
    assert len(calls(av, registered)) == 16
    assert all(e["payload"]["key_source"] == "moralmod" for e in calls(av, registered))
    assert speaker.client.chat.completions.calls == []


def test_the_key_never_reaches_the_buffer_or_the_log(registered, ctx, av, speaker, on, own_key, caplog):
    with caplog.at_level(logging.DEBUG):
        register(registered, ctx)
        speaker.bridge_complete(PAYLOAD)
        speaker.moralmod_error = RuntimeError(f"echo {MORALMOD_KEY}")
        with pytest.raises(RuntimeError):
            speaker.bridge_complete(PAYLOAD)
    raw = json.dumps(av.read_buffer(registered._COLLECTOR))
    assert MORALMOD_KEY not in raw and TENANT_KEY not in raw
    assert MORALMOD_KEY not in caplog.text


@pytest.mark.parametrize("switches", [{}, {"AV_MORALMOD_OWN_KEY": "1"}, {"AV_EVENTS_NEGOTIATOR_LLM": "1"}])
def test_the_key_is_registered_with_the_sanitiser_at_load(plugin, ctx, token, monkeypatch, switches):
    """S3 / mutant K8: registered at plugin load, before any bridge step, whatever the switches."""
    core = sys.modules[f"{plugin.__name__}._core"]
    key = "sk-or-v1-" + "d" * 64
    monkeypatch.setattr(core, "_LITERAL_SECRETS", set())
    monkeypatch.setenv("MORALMOD_LLM_API_KEY", key)
    for name, value in switches.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(nl(plugin), "FAST_S", 3600.0)
    try:
        plugin.register(ctx)
        assert key in core._LITERAL_SECRETS
        assert key not in json.dumps(core.sanitize({"note": f"x {key} y"}))
    finally:
        nl(plugin).stop()


def _custody_module(av):
    """av-approval's `_custody.py` (standard library only), loaded by path under a scratch name."""
    import importlib.util  # noqa: PLC0415

    path = av.PLUGIN_DIR.parent / "av-approval" / "_custody.py"
    spec = importlib.util.spec_from_file_location("av_custody_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_hermes_builders():
    """Hermes's three custody levers as av-approval wraps them (test_custody.py has the full fake):
    the registry, the foreground builder and its caller, the execute_code scrub and its caller."""
    providers: list = []
    reg = types.ModuleType("agent.terminal_env_registry")
    reg.register_provider = providers.append
    reg.plugin_strip_env_keys = lambda: frozenset().union(*(p.strip_env_keys for p in providers))
    base = types.ModuleType("agent.terminal_env_provider")
    base.TerminalEnvironmentProvider = object
    loc = types.ModuleType("tools.environments.local")
    loc._make_run_env = lambda env: {**os.environ, **env}

    def _run_bash(self, command):
        return _make_run_env({})  # noqa: F821 - only its code's names are read

    loc.LocalEnvironment = type("LocalEnvironment", (), {"_run_bash": _run_bash})
    ce = types.ModuleType("tools.code_execution_env")
    ce._scrub_child_env = lambda source_env, is_passthrough=None, is_windows=None: dict(source_env)

    def _build_child_env(**kwargs):
        return _scrub_child_env({})  # noqa: F821

    ce._build_child_env = _build_child_env
    cfg = types.ModuleType("hermes_cli.config")
    cfg.read_raw_config = dict
    cfg.cfg_get = lambda c, *keys, default=None: default
    cli = types.ModuleType("hermes_cli")
    cli.__version__ = "0.21.5"
    modules = {m.__name__: m for m in (reg, base, loc, ce, cfg, cli)}

    def importer(name):
        if name not in modules:
            raise ImportError(name)
        return modules[name]

    return importer, modules, providers


@pytest.mark.parametrize("source", ["environ", "dotenv"])
def test_custody_strips_the_key_from_agent_run_children_and_av_events_still_reads_it_at_load(
        plugin, ctx, token, monkeypatch, av, home, source):
    """CONTRACT (custody_keys.json: MORALMOD_LLM_API_KEY strip, and in av-approval's FLOOR): the
    gateway's own environment keeps the key, so the S3 load path still reads and registers it, while
    every agent-run child av-approval builds (foreground terminal, execute_code with the name declared
    passthrough, Hermes's provider strip list) has it removed."""
    custody = _custody_module(av)
    assert "MORALMOD_LLM_API_KEY" in custody.FLOOR
    assert custody.load_manifest()["names"]["MORALMOD_LLM_API_KEY"]["decision"] == "strip"
    core = sys.modules[f"{plugin.__name__}._core"]
    key = "sk-or-v1-" + "e" * 64
    monkeypatch.setattr(core, "_LITERAL_SECRETS", set())
    if source == "environ":  # Hermes loaded $HERMES_HOME/.env into the gateway's environment
        monkeypatch.setenv("MORALMOD_LLM_API_KEY", key)
    else:  # only on disk: av-events' `env` falls back to $HERMES_HOME/.env
        monkeypatch.delenv("MORALMOD_LLM_API_KEY", raising=False)
        (home / ".env").write_text(f"MORALMOD_LLM_API_KEY={key}\n", encoding="utf-8")
    importer, modules, providers = _fake_hermes_builders()
    assert custody.install(importer=importer) == {"provider": True, "foreground": True, "execute_code": True}

    gateway = {**os.environ, "MORALMOD_LLM_API_KEY": key}
    assert "MORALMOD_LLM_API_KEY" not in modules["tools.environments.local"]._make_run_env(gateway)
    assert "MORALMOD_LLM_API_KEY" not in modules["tools.code_execution_env"]._scrub_child_env(
        gateway, is_passthrough=lambda _name: True)
    assert "MORALMOD_LLM_API_KEY" in providers[0].strip_env_keys

    monkeypatch.setattr(nl(plugin), "FAST_S", 3600.0)
    try:
        plugin.register(ctx)
        assert key in core._LITERAL_SECRETS
        assert nl(plugin)._own_key() == key
        if source == "environ":
            assert os.environ["MORALMOD_LLM_API_KEY"] == key  # custody never edits the gateway's own env
    finally:
        nl(plugin).stop()


def test_the_key_shape_is_as_long_as_the_sanitisers_pattern(plugin):
    module = nl(plugin)
    core = sys.modules[f"{plugin.__name__}._core"]
    pattern = dict(core._SECRET_PATTERNS)["openrouter_key"]
    for key in ("sk-or-" + "a" * 16, MORALMOD_KEY, "sk-or-v1-" + "Z9_-" * 4):
        assert module._OWN_KEY_SHAPE.fullmatch(key) and pattern.fullmatch(key)
    assert not module._OWN_KEY_SHAPE.fullmatch("sk-or-" + "a" * 15)


def test_unload_with_the_switch_on_keeps_the_moralmod_client(registered, ctx, speaker, on, own_key):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    moralmod_client = speaker.agent.client
    registered._on_unload()
    assert speaker.module._main_agent is speaker.original_main_agent
    assert speaker.agent.client is moralmod_client  # never the tenant's key
    assert speaker.bridge_complete(PAYLOAD)["content"] == SECRET_REPLY
    assert speaker.client.chat.completions.calls == []


def test_unload_with_the_switch_off_puts_the_tenant_client_back(registered, ctx, speaker, on, own_key, monkeypatch):
    register(registered, ctx)
    speaker.bridge_complete(PAYLOAD)
    monkeypatch.setenv("AV_MORALMOD_OWN_KEY", "0")
    registered._on_unload()
    assert speaker.agent.client is speaker.client
    assert speaker.module._main_agent is speaker.original_main_agent


def test_the_key_switch_armed_after_load_does_nothing_until_restart(registered, ctx, speaker, monkeypatch):
    """review-b N1: both switches off at load, so no seam; arming the key later changes nothing
    until the gateway restarts (the control plane restarts it when it writes the key)."""
    register(registered, ctx)
    monkeypatch.setenv("AV_MORALMOD_OWN_KEY", "1")
    monkeypatch.setenv("MORALMOD_LLM_API_KEY", MORALMOD_KEY)
    assert nl(registered).install() is False
    speaker.bridge_complete(PAYLOAD)
    assert speaker.agent.client is speaker.client and speaker.agent.built == []


# --------------------------------------------------------------------------
# This home only (review-b S1)
# --------------------------------------------------------------------------


def test_a_speaker_of_another_home_is_never_wrapped_and_is_counted(registered, ctx, av, speaker, on, own_key,
                                                                   tmp_path):
    speaker.module.__file__ = str(tmp_path / "other-home" / "plugins" / "index-network" / "speaker.py")
    register(registered, ctx)
    module = nl(registered)
    assert module.install() is False and module.install() is False
    assert speaker.module._main_agent is speaker.original_main_agent
    speaker.bridge_complete(PAYLOAD)
    assert speaker.agent.client is speaker.client and calls(av, registered) == []
    assert registered._COLLECTOR.counters["negotiator_llm_foreign_home"] == 1


def test_a_speaker_without_a_file_cannot_be_proven_ours(registered, ctx, speaker, on):
    del speaker.module.__file__
    register(registered, ctx)
    assert nl(registered).install() is False
    assert registered._COLLECTOR.counters["negotiator_llm_foreign_home"] == 1


def test_this_homes_speaker_under_a_suffixed_name_is_found(registered, ctx, av, speaker, on, monkeypatch):
    """Hermes names the Index plugin bare for the first home that claims it; this home's may be
    the suffixed one while another home's holds the bare name."""
    suffixed = "hermes_plugins.index_network__home_0123456789ab.speaker"
    other = types.ModuleType(SPEAKER_NAME)
    exec(compile(SPEAKER_SOURCE, "other_home_standin", "exec"), other.__dict__)
    other.__file__ = "/elsewhere/plugins/index-network/speaker.py"
    original_other = other._main_agent
    monkeypatch.setitem(sys.modules, SPEAKER_NAME, other)
    monkeypatch.setitem(sys.modules, suffixed, speaker.module)
    register(registered, ctx)
    assert getattr(speaker.module._main_agent, nl(registered)._MARK, None) is nl(registered)._TOKEN
    assert other._main_agent is original_other
    speaker.bridge_complete(PAYLOAD)
    assert len(calls(av, registered)) == 1
    assert registered._COLLECTOR.counters["negotiator_llm_foreign_home"] == 1


def test_own_plugins_root_is_where_av_events_is_installed(plugin):
    assert nl(plugin).own_plugins_root() == os.path.realpath(str(Path(plugin.__file__).resolve().parents[1]))


# --------------------------------------------------------------------------
# Parity with the real Index plugin at INDEX_PLUGIN_REF (review-b S2)
# --------------------------------------------------------------------------

#: sha256 over the source text of `speaker._main_agent` and `speaker.complete` at 04d833b8.
SEAM_SHA256 = "b4871fbe72845782239de760e8e08a5a07d0912c12d419d2732dc6c12a4abbda"
SEAM_REF = "04d833b840541fedabe78cbdad306c18853d784a"
INDEX_PLUGIN_DIR_ENV = "AV_INDEX_PLUGIN_TEST_DIR"


def _seam(source: str):
    import ast

    tree = ast.parse(source)
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    return tree, functions


def _calls(node) -> list:
    import ast

    out = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            out.append(ast.unparse(sub.func))
    return out


@pytest.fixture()
def real_plugin():
    root = os.environ.get(INDEX_PLUGIN_DIR_ENV, "").strip()
    if not root or not (Path(root) / "speaker.py").is_file():
        pytest.skip(f"{INDEX_PLUGIN_DIR_ENV} names no Index plugin checkout (CI sets it)")
    return Path(root)


def test_the_pin_this_parity_test_holds_is_the_installers(av):
    source = (av.PLUGIN_DIR.parents[1] / "install" / "install_index_plugin.ts").read_text(encoding="utf-8")
    assert f'export const INDEX_PLUGIN_REF = "{SEAM_REF}";' in source, (
        "INDEX_PLUGIN_REF moved: re-review MM-INFER-VIS's seam on the new speaker.py (the bridge's "
        "_main_agent must still build its own AIAgent) and move SEAM_REF and SEAM_SHA256 here with it"
    )


def test_the_real_speakers_main_agent_builds_its_own_agent(real_plugin):
    """The isolation rests on this: `_main_agent` constructs a dedicated `AIAgent` and caches it in
    `_main`, and `complete` reaches it through the module global and calls its client directly."""
    import ast
    import hashlib
    import subprocess

    if (real_plugin / ".git").exists():
        head = subprocess.run(["git", "-C", str(real_plugin), "rev-parse", "HEAD"], capture_output=True,
                              text=True, check=False).stdout.strip()
        assert head == SEAM_REF, f"the Index plugin checkout is at {head}, not the pinned {SEAM_REF}"
    source = (real_plugin / "speaker.py").read_text(encoding="utf-8")
    tree, functions = _seam(source)
    assert {"_main_agent", "complete"} <= set(functions), "speaker.py lost _main_agent or complete"
    main_agent, complete = functions["_main_agent"], functions["complete"]
    assert "AIAgent" in _calls(main_agent), "_main_agent no longer constructs its own AIAgent"
    globals_declared = [n for sub in ast.walk(main_agent) if isinstance(sub, ast.Global) for n in sub.names]
    assert "_main" in globals_declared, "_main_agent no longer caches its agent in the module global _main"
    imports = [alias.name for sub in ast.walk(main_agent) if isinstance(sub, ast.ImportFrom)
               for alias in sub.names if sub.module == "run_agent"]
    assert imports == ["AIAgent"], "_main_agent's AIAgent is no longer run_agent.AIAgent"
    complete_calls = _calls(complete)
    assert "_main_agent" in complete_calls, "complete no longer calls _main_agent through the module global"
    assert "agent.client.chat.completions.create" in complete_calls, "complete no longer calls the client itself"
    bridge = (real_plugin / "bridge.py").read_text(encoding="utf-8")
    assert "from .speaker import complete as complete_turn" in bridge
    seam = "".join(ast.get_source_segment(source, functions[name]) for name in ("_main_agent", "complete"))
    digest = hashlib.sha256(seam.encode("utf-8")).hexdigest()
    assert digest == SEAM_SHA256, (
        "The Index plugin's speaker seam (_main_agent / complete) changed. Re-review MM-INFER-VIS: the "
        "wrap and the MoralMod key switch assume _main_agent builds a dedicated AIAgent used only by "
        f"the bridge. Then move SEAM_SHA256 to {digest}."
    )
