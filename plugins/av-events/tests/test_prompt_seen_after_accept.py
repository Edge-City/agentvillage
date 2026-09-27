"""DATA-112: a prompt hash is seen only once ingest accepted its body.

`register_prompt` used to write the hash into seen.json as soon as the event
was buffered. A body lost after that (the batch expired, or ingest refused it
and it went to `buffer/rejected/`) was never sent again, while every later
`llm.call` still carried the hash. Now the hash is pending from emit until the
batch carrying it gets a 202; an expiry or a refusal drops it from pending, so
the next `pre_api_request` registers the body again.

And the hashes are over `sanitize(body)`, the bytes that actually leave, so a
body with a credential shape in it verifies at the door.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time

TOOLS = [{"type": "function", "function": {"name": "t", "description": "does t"}}]
PROMPT = "You are a helpful agent."


def fire(ctx, request_id, *, tools=TOOLS, system_prompt=PROMPT, session="s"):
    ctx.fire(
        "pre_api_request", session_id=session, turn_id=f"t-{request_id}", api_request_id=request_id,
        system_prompt=system_prompt, tool_count=len(tools),
        request={"method": "POST", "body": {"tools": tools}},
    )


class Ingest:
    """The `Collector.sender` seam: answers from a script, records every offer."""

    def __init__(self, core, statuses):
        self.core = core
        self.statuses = list(statuses)
        self.offered: list[list[dict]] = []

    def __call__(self, url, token, events):
        self.offered.append(events)
        status = self.statuses.pop(0) if self.statuses else 202
        return self.core.SendResult(200 <= status < 300, status)

    def bodies(self, index):
        return sorted(e["payload"]["kind"] for e in self.offered[index] if e["event_type"] == "prompt.registered")


def setup(plugin, ctx, monkeypatch, statuses=()):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    collector = plugin._COLLECTOR
    ingest = Ingest(sys.modules[f"{plugin.__name__}._core"], statuses)
    collector.sender = ingest
    return collector, ingest


def flush(collector):
    collector.buffer.rotate_if_due(force=True)
    collector.tick()


def seen_on_disk(home):
    path = home / "av-events" / "seen.json"
    return json.loads(path.read_text())["hashes"] if path.exists() else {}


def registered(av, collector):
    return [e for e in av.read_buffer(collector) if e["event_type"] == "prompt.registered"]


def test_a_hash_is_seen_only_after_its_batch_got_a_202(plugin, ctx, monkeypatch, home, av):
    """AC #1."""
    collector, ingest = setup(plugin, ctx, monkeypatch)
    fire(ctx, "r0")
    assert len(registered(av, collector)) == 2
    assert seen_on_disk(home) == {}, "buffered is not delivered"

    # While the batch waits, the same bytes are not registered twice.
    fire(ctx, "r1")
    assert len(registered(av, collector)) == 2

    flush(collector)
    assert ingest.bodies(0) == ["system_prompt", "tools"]
    assert sorted(seen_on_disk(home).values()) == ["system_prompt", "tools"]
    fire(ctx, "r2")
    assert registered(av, collector) == []


def test_a_refused_flush_then_an_accepted_one_resends_the_body(plugin, ctx, monkeypatch, home, av):
    """AC #2 and #3: 422 (quarantined to buffer/rejected/), then a later 202."""
    collector, ingest = setup(plugin, ctx, monkeypatch, statuses=[422])
    fire(ctx, "r0")
    flush(collector)
    assert ingest.bodies(0) == ["system_prompt", "tools"]
    assert os.listdir(os.path.join(collector.config.buffer_dir, "rejected"))
    assert seen_on_disk(home) == {}

    fire(ctx, "r1")
    assert len(registered(av, collector)) == 2, "registered again after the refusal"
    flush(collector)
    assert ingest.bodies(1) == ["system_prompt", "tools"]
    assert sorted(seen_on_disk(home).values()) == ["system_prompt", "tools"]


def test_an_expired_batch_is_registered_again(plugin, ctx, monkeypatch, home, av):
    """AC #2, the expiry half."""
    collector, ingest = setup(plugin, ctx, monkeypatch)
    core = sys.modules[f"{plugin.__name__}._core"]
    fire(ctx, "r0")
    collector.buffer.rotate_if_due(force=True)
    root = collector.config.buffer_dir
    ready = [n for n in os.listdir(root) if n.endswith(".jsonl") and not n.startswith("current-")]
    assert len(ready) == 1
    expired_ms = int((time.time() - core.MAX_BUFFER_AGE_S - 60) * 1000)
    os.rename(os.path.join(root, ready[0]), os.path.join(root, f"{expired_ms:013d}-1-9000.jsonl"))
    collector.tick()
    assert ingest.offered == [], "an expired batch is never sent"
    assert seen_on_disk(home) == {}

    fire(ctx, "r1")
    assert len(registered(av, collector)) == 2


def test_a_retryable_failure_keeps_the_hash_pending(plugin, ctx, monkeypatch, home, av):
    """A 503 leaves the batch queued: no second body while it waits."""
    collector, _ = setup(plugin, ctx, monkeypatch, statuses=[503])
    fire(ctx, "r0")
    flush(collector)
    assert seen_on_disk(home) == {}
    fire(ctx, "r1")
    assert len(registered(av, collector)) == 2, "only the queued batch's two"


def test_a_2xx_that_is_not_202_does_not_mark_seen(plugin, ctx, monkeypatch, home, av):
    collector, _ = setup(plugin, ctx, monkeypatch, statuses=[200])
    fire(ctx, "r0")
    flush(collector)
    assert seen_on_disk(home) == {}
    fire(ctx, "r1")
    assert len(registered(av, collector)) == 2


def test_an_adopted_batch_accepted_by_ingest_settles_its_hashes(plugin, ctx, monkeypatch, home):
    """A 202 proves the body landed whoever buffered it."""
    collector, _ = setup(plugin, ctx, monkeypatch)
    event = {"event_id": "x", "event_type": "prompt.registered",
             "payload": {"hash": "a" * 64, "kind": "tools", "body": []}}
    collector._settle_prompts([event], accepted=True)
    assert seen_on_disk(home) == {"a" * 64: "tools"}


def test_hashes_are_over_the_sanitised_body(plugin, ctx, monkeypatch, home, av):
    """AC #4: the hash names the bytes that leave, so the door can verify it."""
    collector, _ = setup(plugin, ctx, monkeypatch)
    tools = [{"type": "function", "function": {"name": "t", "description": "Send Bearer authentication headers"}}]
    prompt = f"Your bot token is 123456789:AA{'B' * 30}. Keep it safe."
    fire(ctx, "r0", tools=tools, system_prompt=prompt)
    ctx.fire("post_api_request", session_id="s", turn_id="t-r0", api_request_id="r0", model="m",
             usage={"input_tokens": 1, "output_tokens": 1})
    events = av.read_buffer(collector)
    bodies = {e["payload"]["kind"]: e["payload"] for e in events if e["event_type"] == "prompt.registered"}
    assert "[redacted:bearer]" in json.dumps(bodies["tools"]["body"])
    assert "[redacted:telegram_bot_token]" in bodies["system_prompt"]["body"]

    # What the door recomputes: the hash of the body it received.
    assert bodies["tools"]["hash"] == plugin.hash_obj(bodies["tools"]["body"])
    assert bodies["system_prompt"]["hash"] == hashlib.sha256(
        bodies["system_prompt"]["body"].encode("utf-8")).hexdigest()
    assert bodies["tools"]["hash"] != plugin.hash_obj(tools)

    llm = [e for e in events if e["event_type"] == "llm.call"]
    assert llm and llm[0]["payload"]["tools_hash"] == bodies["tools"]["hash"]
    assert llm[0]["payload"]["system_prompt_hash"] == bodies["system_prompt"]["hash"]
