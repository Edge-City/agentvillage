"""`memory.recalled` — the one event this plugin takes from another plugin.

`plugins/recall` publishes `recall:memory.recalled` on the Hermes plugin event
bus; this plugin subscribes and turns it into an envelope. The payload is
rebuilt from four allowlisted fields, so nothing the publisher adds — query
text, snippets, refs — can reach the buffer.
"""

from __future__ import annotations

import json

import pytest

HASH = "a" * 64
QUERY_TEXT = "coffee with Priya about the battery enclosure"
SNIPPET = "Coffee chat with Priya about the battery enclosure and heat sinks."


def recalled(ctx, **overrides):
    payload = {
        "query_hash": HASH,
        "hit_count": 3,
        "top_score": 1.23456789,
        "surface": "telegram",
        "session_id": "sess-recall",
    }
    payload.update(overrides)
    ctx.publish("recall:memory.recalled", **payload)


def recalled_events(plugin, av):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "memory.recalled"]


def test_register_subscribes_to_the_recall_bus_event(plugin, ctx):
    plugin.register(ctx)
    assert list(ctx.subscriptions) == ["recall:memory.recalled"]
    # Subscribing adds no hook: the spec hook set is unchanged.
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)


def test_register_tolerates_a_ctx_without_an_event_bus(plugin):
    class HooksOnly:
        def __init__(self):
            self.hooks = {}

        def register_hook(self, name, callback):
            self.hooks[name] = callback

    ctx = HooksOnly()
    plugin.register(ctx)
    assert set(ctx.hooks) == set(plugin.HOOK_BODIES)


def test_a_published_recall_becomes_an_envelope(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    recalled(ctx)

    events = recalled_events(plugin, av)
    assert len(events) == 1
    event = events[0]
    assert event["payload"] == {"query_hash": HASH, "hit_count": 3, "top_score": 1.2346, "surface": "telegram"}
    assert event["session_id"] == "sess-recall"
    assert event["evidence_class"] == "agent_report"


def test_payload_carries_no_text_even_when_the_publisher_sends_it(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    recalled(
        ctx,
        query=QUERY_TEXT,
        snippets=[SNIPPET],
        hits=[{"ref": "memory/2026-09-20.md:3-4", "snippet": SNIPPET}],
        refs=["MEMORY.md:7-8"],
    )

    events = recalled_events(plugin, av)
    assert len(events) == 1
    assert set(events[0]["payload"]) == {"query_hash", "hit_count", "top_score", "surface"}
    serialised = json.dumps(events[0])
    for text in (QUERY_TEXT, SNIPPET, "Priya", "memory/2026-09-20.md", "MEMORY.md"):
        assert text not in serialised


@pytest.mark.parametrize(
    "overrides",
    [
        {"query_hash": QUERY_TEXT},  # the query itself, not a digest
        {"query_hash": "A" * 64},  # not lowercase hex
        {"query_hash": "a" * 63},
        {"query_hash": None},
        {"hit_count": -1},
        {"hit_count": "3"},
        {"hit_count": True},
        {"top_score": float("nan")},
        {"top_score": "high"},
    ],
)
def test_malformed_payloads_are_dropped(plugin, ctx, monkeypatch, av, overrides):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    recalled(ctx, **overrides)
    assert recalled_events(plugin, av) == []


def test_zero_hits_and_no_score_are_valid(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    recalled(ctx, hit_count=0, top_score=None)
    assert recalled_events(plugin, av)[0]["payload"]["top_score"] is None


def test_an_unknown_surface_is_bucketed(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    recalled(ctx, surface="whatsapp-group-name")
    assert recalled_events(plugin, av)[0]["payload"]["surface"] == "other"


def test_idle_without_a_token(plugin, ctx, av):
    plugin.register(ctx)
    recalled(ctx)
    assert plugin._COLLECTOR is not None
    assert recalled_events(plugin, av) == []


def test_can_be_switched_off_like_a_hook(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "memory_recalled")
    plugin.register(ctx)
    recalled(ctx)
    assert recalled_events(plugin, av) == []


def test_a_failing_subscriber_does_not_raise(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)

    def boom(*args, **kwargs):
        raise RuntimeError("buffer exploded")

    monkeypatch.setattr(plugin._COLLECTOR, "emit", boom)
    recalled(ctx)  # FakeCtx does not swallow; the guard must


def test_metadata_capture_keeps_counts_and_surface_only(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    recalled(ctx)
    payload = recalled_events(plugin, av)[0]["payload"]
    assert payload == {"query_hash": None, "hit_count": 3, "top_score": None, "surface": "telegram"}


def test_metadata_capture_still_drops_a_malformed_publish(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    recalled(ctx, query_hash=QUERY_TEXT)
    assert recalled_events(plugin, av) == []
