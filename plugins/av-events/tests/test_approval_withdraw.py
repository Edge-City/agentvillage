"""The withdraw verb as core 0.4.7 takes it (commandWithdraw): by action key (`--action`; without it, a usage error at
exit 2 that withdraws nothing) and a closed reason. For Kicks' quote-expiry and supersede withdraws pass the key."""

from __future__ import annotations

import pytest


@pytest.fixture()
def ap(plugin, av, monkeypatch):
    import sys
    module = sys.modules[f"{av.MODULE_NAME}._approval"]
    sent = []
    monkeypatch.setattr(module, "call", lambda verb, positionals=None, flags=None: sent.append((verb, positionals, flags)))
    module.sent = sent
    return module


def test_a_withdraw_with_a_key_sends_it_as_the_action(ap):
    key = "marketplace.app.action:forkicks.order.confirm:d1"
    ap.withdraw("propose:" + "a" * 32, "timeout", key)
    assert ap.sent == [("withdraw", ["propose:" + "a" * 32], {"--reason": "timeout", "--json": True, "--action": key})]


def test_a_withdraw_without_a_key_sends_what_it_sent_before(ap):
    ap.withdraw("propose:" + "a" * 32, "superseded")
    assert ap.sent == [("withdraw", ["propose:" + "a" * 32], {"--reason": "superseded", "--json": True})]
