import json
import sys
import types
from types import SimpleNamespace

import pytest

def update(data="rv1.ABCDEFGHIJKLMNOPQRSTUV"):
    query = SimpleNamespace(
        id="cb-1", data=data, from_user=SimpleNamespace(id=123),
        message=SimpleNamespace(message_id=44, chat=SimpleNamespace(id=123)),
    )
    return SimpleNamespace(update_id=77, callback_query=query)


def test_callback_event_is_closed_and_uses_native_ids(plugin):
    referendum = plugin._referendum
    event = referendum.callback_event(update())
    assert event["type"] == "referendum.telegram_callback@1"
    assert event["callbackToken"] == "ABCDEFGHIJKLMNOPQRSTUV"
    assert event["callbackId"] == "cb-1"
    assert event["updateId"] == 77
    assert event["telegramUserId"] == event["chatId"] == "123"
    assert event["messageId"] == 44
    assert set(event) == {"type", "callbackToken", "callbackId", "updateId", "telegramUserId", "chatId", "messageId", "occurredAt"}


def test_callback_uses_the_shared_hardened_opener(plugin):
    core = sys.modules[f"{plugin.__package__}._core"]
    assert plugin._referendum.NO_REDIRECT_OPENER is core.NO_REDIRECT_OPENER


@pytest.mark.parametrize("data", ["vote:x", "rv1.short", "rv1." + "a" * 23, "rv1." + "!" * 22])
def test_callback_event_rejects_other_callbacks(plugin, data):
    referendum = plugin._referendum
    with pytest.raises(ValueError, match="callback_invalid"):
        referendum.callback_event(update(data))


def test_registration_is_flagged_and_requires_supported_hermes(plugin, monkeypatch):
    referendum = plugin._referendum
    calls = []
    ctx = SimpleNamespace(register_telegram_handler=calls.append)
    monkeypatch.delenv("AV_REFERENDUM_RUNTIME", raising=False)
    assert referendum.register_telegram_callback(ctx) is False
    monkeypatch.setenv("AV_REFERENDUM_RUNTIME", "1")
    assert referendum.register_telegram_callback(ctx) is True
    assert len(calls) == 1
    with pytest.raises(RuntimeError, match="hermes_0_21_5"):
        referendum.register_telegram_callback(SimpleNamespace())


def test_factory_records_active_handler_capability(plugin, monkeypatch, tmp_path):
    referendum = plugin._referendum
    monkeypatch.setenv("AV_REFERENDUM_RUNTIME", "1")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    factories = []
    ctx = SimpleNamespace(register_telegram_handler=factories.append)

    class CallbackQueryHandler:
        def __init__(self, callback, pattern):
            self.callback = callback
            self.pattern = pattern

    telegram = types.ModuleType("telegram")
    telegram_ext = types.ModuleType("telegram.ext")
    telegram_ext.CallbackQueryHandler = CallbackQueryHandler
    telegram.ext = telegram_ext
    monkeypatch.setitem(sys.modules, "telegram", telegram)
    monkeypatch.setitem(sys.modules, "telegram.ext", telegram_ext)

    class Application:
        def add_handler(self, handler):
            self.handler = handler

    referendum.register_telegram_callback(ctx)
    application = Application()
    factories[0](application, None)
    assert application.handler.pattern == referendum.CALLBACK_PATTERN
    marker = json.loads((tmp_path / "state/referendum-runtime-capability.json").read_text())
    assert marker["version"] == 1
    assert marker["callbackPattern"] == referendum.CALLBACK_PATTERN


def test_content_hash_contract(plugin):
    referendum = plugin._referendum
    body = {"referendumId": "r", "frozenAt": "2026-10-14T00:00:00Z", "question": "Q?", "context": "C", "options": [{"optionId": "a", "label": "A"}]}
    assert referendum.canonical_content_hash(body) == "8f5b99ff96afe50db096855b3e838ea58ee37c76bca5f0d0079714ed58349834"
