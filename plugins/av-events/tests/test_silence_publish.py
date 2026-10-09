"""DATA-411: a silence capture from a cron send publishes only the exact draft
the resident already saw.

At the one ask ("Should I publish this as written?") the tool's own
`post_llm_call` listener opens a draft in the process's memory (never a file,
which anything in the sandbox could forge): the sha256 of each candidate span's
exact bytes, when, and the session and platform; only from a root session that R10 says a person is speaking in. The
tool's `pre_llm_call` listener closes every open ask at any turn but a cron
run's. A capture passed as `message` with `confirmed_in_chat=silence` that R10
holds as `held_cron` publishes as stated only when its exact text is in an open
ask shown within `SILENCE_PUBLISH_WINDOW_HOURS`; the ask is closed first (once
only). Everything else stays exactly as before. Index is faked in-process; no
test reaches the network.

Mutants (one at a time, see the lane report): (a) no window check, killed by
`test_a_stale_draft_is_held` and the stale probe; (b) no close on use, killed by
`test_the_same_capture_again_is_held_cron`; (c) the capture's text stripped
before hashing, killed by `test_a_one_byte_edit_is_held`; (d) the open from a
cron lineage, killed by `test_a_cron_or_delegated_ask_opens_nothing`; (e) no
close on a resident turn, killed by `test_a_resident_turn_closes_every_open_draft`.
"""

from __future__ import annotations

import io
import json
import os
import re
import builtins
import sys
import threading
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

SESSION = "sess-ask"
CRON = "cron_evening_20261009_180000"
KEY = "index-key-for-silence-publish-tests-0123456789"
INDEX_ID = "9b2f0c1e-0000-4000-8000-00000000d411"
DRAFT = "Meet founders building on Solana in Goa"
OTHER = "Find a climbing partner in Goa on weekends"
ASK = "Should I publish this as written?"
T0 = 1_791_000_000.0
PROBES = json.loads((Path(__file__).parent / "vectors" / "silence_publish_probes.json").read_text(encoding="utf-8"))


def ask_reply(draft: str = DRAFT) -> str:
    return f'Here is how I would put it:\n\n"{draft}"\n\n{ASK}'


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------


class Response:
    def __init__(self, body: bytes) -> None:
        self.status = 200
        self._body = io.BytesIO(body)

    def read(self, n: int = -1) -> bytes:
        return self._body.read(n)

    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class FakeIndex:
    """Index's `POST /api/intents`, in-process; every request is recorded."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self._lock = threading.Lock()

    def open(self, request, timeout=None):  # noqa: ANN001 - urllib's opener API
        with self._lock:
            self.requests.append({
                "path": urllib.parse.urlsplit(request.full_url).path,
                "method": request.get_method(),
                "body": json.loads(request.data.decode()) if request.data is not None else None,
            })
        body = {"intentId": INDEX_ID, "networkIds": [], "sourceType": "agentvillage", "sourceId": None}
        return Response(json.dumps(body).encode())


class ToolFireCtx:
    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.tools: dict[str, dict] = {}

    def register_hook(self, hook_name, callback):  # noqa: ANN001
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                      is_async=False, description="", emoji="", override=False):  # noqa: ANN001
        self.tools[name] = {"handler": handler}
        return object()

    def fire(self, hook_name: str, **kwargs: Any) -> list:
        return [callback(**kwargs) for callback in self.hooks.get(hook_name, [])]


class Clock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


# --------------------------------------------------------------------------
# Fixtures and helpers
# --------------------------------------------------------------------------


@pytest.fixture()
def ri(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._record_intention"]


@pytest.fixture()
def index(ri, monkeypatch):
    fake = FakeIndex()
    monkeypatch.setattr(ri, "_OPENER", fake)
    return fake


@pytest.fixture()
def clock(ri, monkeypatch):
    fake = Clock(T0)
    monkeypatch.setattr(ri, "_clock", fake)
    return fake


@pytest.fixture()
def tctx(plugin, index, clock, monkeypatch, home):
    """The plugin registered and live, the tool on, in a Telegram session."""
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("INDEX_API_KEY", KEY)
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = ToolFireCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    ctx.fire("on_session_start", session_id=CRON, model="m", platform="cron")
    return ctx


def show(ctx: ToolFireCtx, reply: str, *, session: str = SESSION, platform: str = "telegram") -> None:
    """The agent's reply at the end of a turn, as Hermes fires it."""
    ctx.fire("post_llm_call", session_id=session, task_id="t", turn_id="u", user_message="hi",
             assistant_response=reply, conversation_history=[], model="m", platform=platform)


def resident_says(ctx: ToolFireCtx, text: str, *, session: str = SESSION, platform: str = "telegram") -> None:
    ctx.fire("pre_llm_call", session_id=session, task_id="t", turn_id="u2", user_message=text,
             conversation_history=[], is_first_turn=False, model="m", platform=platform,
             parent_session_id="", sender_id="")


def call(ctx: ToolFireCtx, args: dict, *, session: str = CRON, tool_call_id: str = "call-1") -> dict:
    handler = ctx.tools["record_intention"]["handler"]
    result = handler(args, task_id="task-1", session_id=session)
    ctx.fire("post_tool_call", tool_name="record_intention", args=args, result=result, session_id=session,
             task_id="task-1", turn_id="turn-1", tool_call_id=tool_call_id, api_request_id="req-1",
             duration_ms=120, status="error" if '"error"' in result else "ok", error_type=None, error_message=None)
    return json.loads(result)


def silence(text: str = DRAFT, **extra: Any) -> dict:
    return {"text": text, "source": "message", "confirmed_in_chat": "silence", **extra}


def drafts(ri) -> list[dict]:
    """The open asks, with `shown_at` as the UTC string the result carries."""
    with ri._DRAFTS_LOCK:
        return [{**d, "shown_at": ri._iso(d["shown_at"])} for d in ri._OPEN_DRAFTS]


def intention_events(av, plugin) -> list[dict]:
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"].startswith("intention.")]


def assert_held_cron(out: dict, index: FakeIndex) -> None:
    """Exactly the pre-DATA-411 answer for a cron silence capture."""
    assert out["success"] is True and out["published"] is False and out["held"] is True
    assert out["source"] == "ambient" and out["publish_refused"] == "held_cron"
    assert "publish_via" not in out and "draft_shown_at" not in out
    assert index.requests == []


# --------------------------------------------------------------------------
# Opening a draft at the ask
# --------------------------------------------------------------------------


def test_the_ask_question_is_the_draft_rules(ri):
    assert ri.ASK_QUESTION == ASK and ASK in ri.DRAFT_RULE
    assert ri.SILENCE_PUBLISH_WINDOW_HOURS == 24 and ri.MAX_OPEN_DRAFTS == 20


def test_the_listeners_are_registered_with_the_tool_and_only_then(plugin, ri, tctx, monkeypatch):
    for name, listener in ri.DRAFT_HOOKS.items():
        assert listener in tctx.hooks[name]
    monkeypatch.setenv("AV_RECORD_INTENTION", "0")
    off = ToolFireCtx()
    monkeypatch.setattr(plugin, "_REGISTERED", False)
    plugin.register(off)
    for name, listener in ri.DRAFT_HOOKS.items():
        assert listener not in off.hooks.get(name, [])


def test_a_human_facing_ask_opens_a_draft(tctx, ri, clock):
    show(tctx, ask_reply())
    [entry] = drafts(ri)
    assert ri.draft_hash(DRAFT) in entry["hashes"]
    assert entry["shown_at"] == ri._iso(T0) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", entry["shown_at"])
    assert entry["session_id"] == SESSION and entry["platform"] == "telegram"
    assert set(entry) == {"hashes", "shown_at", "session_id", "platform"}
    # Hashes only: the words are not kept.
    assert DRAFT not in repr(ri._OPEN_DRAFTS)


def test_the_listener_returns_nothing_to_hermes(tctx, ri):
    """A `pre_llm_call` return value would be injected into the prompt."""
    assert ri.DRAFT_HOOKS["pre_llm_call"](session_id=SESSION, user_message="hi") is None
    assert ri.DRAFT_HOOKS["post_llm_call"](session_id=SESSION, assistant_response=ask_reply()) is None


@pytest.mark.parametrize("setup,session,platform", [
    # A cron run: by its platform, by its id alone, and by the hook's platform.
    ([("on_session_start", "cron_job_1", "cron")], "cron_job_1", "cron"),
    ([("on_session_start", "cron_job_2", "telegram")], "cron_job_2", "telegram"),
    ([("on_session_start", "s-cronhook", "telegram")], "s-cronhook", "cron"),
    # A subagent of a cron run, and of the resident's chat (its reply goes to the parent agent).
    ([("subagent_start", "child-of-cron", CRON), ("pre_api_request", "child-of-cron", "subagent")], "child-of-cron", "subagent"),
    ([("subagent_start", "child-of-chat", SESSION), ("pre_api_request", "child-of-chat", "telegram")], "child-of-chat", "telegram"),
    # A machine-facing platform, and a session never seen.
    ([("on_session_start", "s-api", "api_server")], "s-api", "api_server"),
    ([("on_session_start", "s-webhook", "webhook")], "s-webhook", ""),
    ([], "never-seen", "telegram"),
    ([], "", "telegram"),
])
def test_a_cron_or_delegated_ask_opens_nothing(tctx, ri, index, setup, session, platform):
    """Mutant (d): the open allowed from a cron lineage is killed here."""
    for hook, sid, value in setup:
        if hook == "subagent_start":
            tctx.fire(hook, child_session_id=sid, parent_session_id=value)
        else:
            tctx.fire(hook, session_id=sid, platform=value, model="m")
    show(tctx, ask_reply(), session=session, platform=platform)
    assert ri._OPEN_DRAFTS == []
    assert_held_cron(call(tctx, silence()), index)


@pytest.mark.parametrize("reply", [
    f'"{DRAFT}"',  # no question
    f'"{DRAFT}"\n\nShould I publish it as written?',  # not the question word for word
    f'"{DRAFT}"\n\n¿Lo publico tal cual?',  # translated
    f'"{DRAFT}"\n\n{ASK}' + "\n" + "x" * 2000,  # too long for one message
    "",
    None,
])
def test_a_reply_without_the_one_ask_opens_nothing(tctx, ri, index, reply):
    show(tctx, reply)
    assert drafts(ri) == []
    assert_held_cron(call(tctx, silence()), index)


# --------------------------------------------------------------------------
# The pass
# --------------------------------------------------------------------------


def test_a_cron_silence_capture_of_the_shown_draft_publishes_and_closes_it(tctx, ri, index, clock, av, plugin):
    show(tctx, ask_reply())
    clock.now = T0 + 4 * 3600
    out = call(tctx, silence())
    assert out["success"] is True and out["published"] is True
    assert out["source"] == "message" and out["confirmed_in_chat"] == "silence"
    assert out["intention_id"] == INDEX_ID and out["index_intent_id"] == INDEX_ID
    assert out["publish_via"] == "open_draft" and out["draft_shown_at"] == ri._iso(T0)
    assert "publish_refused" not in out and "held" not in out
    # The exact bytes, sent as they are.
    assert [r["body"]["description"] for r in index.requests] == [DRAFT]
    # Closed before the publish went on.
    assert drafts(ri) == []
    # The event says how it passed. The observer's own cron check keeps the
    # restrictive source on the event (the more restrictive of the two wins).
    [event] = intention_events(av, plugin)
    payload = event["payload"]
    assert payload["publish_via"] == "open_draft" and payload["draft_shown_at"] == ri._iso(T0)
    assert payload["confirmed_in_chat"] == "silence" and payload["index_intent_id"] == INDEX_ID
    assert payload["publish_refused"] is None and payload["source"] == "ambient"
    # The local map has it as a published stated intention, no held hash.
    assert ri._load_map()[INDEX_ID] == {"published": True, "source": "message"}


def test_the_same_capture_again_is_held_cron(tctx, ri, index):
    """Mutant (b): no close on use is killed here (a replay would publish twice)."""
    show(tctx, ask_reply())
    assert call(tctx, silence())["published"] is True
    index.requests.clear()
    assert_held_cron(call(tctx, silence(), tool_call_id="c2"), index)


@pytest.mark.parametrize("age,passes", [(1, True), (24 * 3600, True), (24 * 3600 + 1, False), (72 * 3600, False), (-1, False)])
def test_a_stale_draft_is_held(tctx, ri, index, clock, age, passes):
    """Mutant (a): no window check is killed here. A draft from the future (a
    clock set back) is not fresh either."""
    show(tctx, ask_reply())
    clock.now = T0 + age
    out = call(tctx, silence())
    if passes:
        assert out["published"] is True and out["publish_via"] == "open_draft"
    else:
        assert_held_cron(out, index)
        # A held capture does not close the ask.
        assert len(drafts(ri)) == 1


@pytest.mark.parametrize("edited", [
    DRAFT + " ", " " + DRAFT, DRAFT + "\n", DRAFT + ".", DRAFT.lower(), DRAFT.upper(),
    DRAFT.replace(" ", " ", 1), DRAFT.replace("Goa", "Bangalore"), DRAFT[:-1], DRAFT + "​",
])
def test_a_one_byte_edit_is_held(tctx, ri, index, edited):
    """Mutant (c): hashing a stripped text is killed here (the whitespace edits)."""
    show(tctx, ask_reply())
    assert_held_cron(call(tctx, silence(edited)), index)
    assert len(drafts(ri)) == 1
    # The ask stays open for the exact words. When the edit differs only in
    # case or whitespace, the held capture's fingerprint (R9) keeps them off
    # Index too: the card already asks about them.
    out = call(tctx, silence(), tool_call_id="c2")
    if ri.held_norm_hash(edited) == ri.held_norm_hash(DRAFT):
        assert out["published"] is False and out["publish_refused"] == "held_ambient_exists"
        assert index.requests == []
    else:
        assert out["published"] is True and out["publish_via"] == "open_draft"


def test_a_marker_without_any_draft_is_held(tctx, ri, index):
    assert_held_cron(call(tctx, silence()), index)
    assert ri._OPEN_DRAFTS == []


@pytest.mark.parametrize("marker", ["yes", "standing", None])
def test_only_silence_passes(tctx, ri, index, marker):
    show(tctx, ask_reply())
    args = {"text": DRAFT, "source": "message"}
    if marker is not None:
        args["confirmed_in_chat"] = marker
    assert_held_cron(call(tctx, args), index)
    assert len(drafts(ri)) == 1


@pytest.mark.parametrize("source", ["onboarding", "note"])
def test_another_explicit_source_from_cron_is_held(tctx, ri, index, source):
    show(tctx, ask_reply())
    assert_held_cron(call(tctx, {"text": DRAFT, "source": source}), index)
    assert len(drafts(ri)) == 1


@pytest.mark.parametrize("session,code", [("never-seen", "held_unknown"), (SESSION, "held_silence")])
def test_the_pass_is_for_cron_only(tctx, ri, index, session, code):
    show(tctx, ask_reply())
    out = call(tctx, silence(), session=session)
    assert out["published"] is False and out["publish_refused"] == code and "publish_via" not in out
    assert index.requests == []
    assert len(drafts(ri)) == 1


def test_publish_false_wins_and_leaves_the_draft_open(tctx, ri, index):
    show(tctx, ask_reply())
    out = call(tctx, silence(publish=False, reason="personal"))
    assert out["published"] is False and out["local_reason"] == "personal"
    assert "publish_refused" not in out and "publish_via" not in out
    assert index.requests == []
    assert len(drafts(ri)) == 1


def test_a_marker_from_the_cron_session_itself_is_held(tctx, ri, index):
    """The cron run shows a draft and asks (or says it did): nothing opens."""
    show(tctx, ask_reply(), session=CRON, platform="cron")
    assert ri._OPEN_DRAFTS == []
    assert_held_cron(call(tctx, silence()), index)


def test_two_drafts_open_the_matching_one_passes_and_closes(tctx, ri, index, clock):
    show(tctx, ask_reply(DRAFT))
    clock.now = T0 + 60
    show(tctx, ask_reply(OTHER))
    out = call(tctx, silence(OTHER))
    assert out["published"] is True and out["draft_shown_at"] == ri._iso(T0 + 60)
    [left] = drafts(ri)
    assert ri.draft_hash(DRAFT) in left["hashes"] and left["shown_at"] == ri._iso(T0)
    out = call(tctx, silence(DRAFT), tool_call_id="c2")
    assert out["published"] is True and out["draft_shown_at"] == ri._iso(T0)
    assert drafts(ri) == []


def test_the_same_words_in_two_asks_pass_once(tctx, ri, index, clock):
    show(tctx, ask_reply())
    clock.now = T0 + 60
    show(tctx, f"> {DRAFT}\n\n{ASK}")
    assert call(tctx, silence())["published"] is True
    assert drafts(ri) == []
    index.requests.clear()
    assert_held_cron(call(tctx, silence(), tool_call_id="c2"), index)


def test_one_ask_passes_one_span(tctx, ri, index):
    """The line as shown (quotes included) and its inside are spans of one ask:
    once one passes, the other is held."""
    show(tctx, ask_reply())
    assert call(tctx, silence(f'"{DRAFT}"'))["published"] is True
    index.requests.clear()
    assert_held_cron(call(tctx, silence(), tool_call_id="c2"), index)


def test_the_state_is_bounded_at_twenty_oldest_dropped(tctx, ri, index, clock):
    texts = [f"Meet people working on project {n} in Goa" for n in range(25)]
    for n, text in enumerate(texts):
        clock.now = T0 + n
        show(tctx, ask_reply(text))
    kept = drafts(ri)
    assert len(kept) == 20
    assert [d["shown_at"] for d in kept] == [ri._iso(T0 + n) for n in range(5, 25)]
    assert_held_cron(call(tctx, silence(texts[0])), index)
    assert call(tctx, silence(texts[5]), tool_call_id="c2")["published"] is True


def test_a_resident_turn_closes_every_open_draft(tctx, ri, index):
    """Whatever they said (a no included), it was not silence."""
    show(tctx, ask_reply())
    resident_says(tctx, "No, don't post that.")
    assert drafts(ri) == []
    assert_held_cron(call(tctx, silence()), index)


@pytest.mark.parametrize("session,platform", [(CRON, "cron"), ("cron_other_1", "")])
def test_a_cron_turn_does_not_close_drafts(tctx, ri, index, session, platform):
    show(tctx, ask_reply())
    resident_says(tctx, "Run the evening digest.", session=session, platform=platform)
    assert len(drafts(ri)) == 1
    assert call(tctx, silence())["published"] is True


def test_an_unknown_turn_closes_drafts_fail_closed(tctx, ri, index):
    show(tctx, ask_reply())
    resident_says(tctx, "webhook payload", session="never-seen", platform="")
    assert drafts(ri) == []


def test_a_new_ask_after_a_resident_turn_opens_again(tctx, ri, index, clock):
    show(tctx, ask_reply(OTHER))
    resident_says(tctx, "Hmm, something about Solana instead?")
    clock.now = T0 + 30
    show(tctx, ask_reply())
    [entry] = drafts(ri)
    assert entry["shown_at"] == ri._iso(T0 + 30)
    assert call(tctx, silence())["published"] is True


# --------------------------------------------------------------------------
# The open asks live in memory only
# --------------------------------------------------------------------------


def test_the_open_drafts_never_touch_a_file(tctx, ri, index, monkeypatch, home):
    """Fix round 0: anything in the sandbox can write a file under
    $HERMES_HOME, so the open asks live in memory only. Opening, taking and
    closing never open, write, rename or create a path."""
    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError(f"file access on the open-draft path: {args[:1]!r}")

    with monkeypatch.context() as m:
        for target, name in ((builtins, "open"), (os, "open"), (os, "replace"), (os, "rename"),
                             (os, "makedirs"), (os, "mkdir"), (os, "unlink"), (os, "stat")):
            m.setattr(target, name, refuse)
        assert ri.note_ask(SESSION, "telegram", ask_reply()) > 0
        assert ri.take_open_draft(DRAFT) == ri._iso(T0)
        assert ri.note_ask(SESSION, "telegram", ask_reply(OTHER)) > 0
        ri.close_open_drafts(SESSION)
    assert ri._OPEN_DRAFTS == []
    # A full ask -> cron pass through the hooks and the tool leaves no draft file.
    show(tctx, ask_reply())
    assert call(tctx, silence())["published"] is True
    assert [p for p in Path(home).rglob("*") if "draft" in p.name] == []


def test_a_forged_drafts_file_opens_nothing(tctx, ri, index, home):
    """The attack the file design allowed: a cron session's terminal writes an
    "open ask" for any text, then captures it with silence. Held."""
    forged = {"v": 1, "drafts": [{"hashes": [ri.draft_hash(DRAFT)], "shown_at": ri._iso(T0),
                                  "session_id": SESSION, "platform": "telegram"}]}
    for name in ("open_drafts.json", "drafts.json"):
        target = Path(home) / "av-events" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(forged), encoding="utf-8")
    assert_held_cron(call(tctx, silence()), index)


def test_a_restart_between_the_ask_and_the_cron_send_holds_it(tctx, ri, index, plugin, av):
    """A gateway restart loses the open asks (memory only): fail closed."""
    show(tctx, ask_reply())
    assert len(drafts(ri)) == 1
    with ri._DRAFTS_LOCK:
        ri._OPEN_DRAFTS.clear()  # what a fresh process starts with
    assert_held_cron(call(tctx, silence()), index)


def test_a_reloaded_module_starts_with_no_open_draft(ri):
    assert ri._OPEN_DRAFTS == [] and ri.take_open_draft(DRAFT) is None


def test_through_approval_the_pass_is_a_stated_capture(tctx, ri, index, monkeypatch):
    """With approval.md on, the pass goes where any stated capture goes."""
    seen: list[tuple[str, str]] = []

    def stated(result: dict, text: str, source: str) -> dict:
        seen.append((text, source))
        return {**result, "intention_id": "0199aaaa-0000-7000-8000-000000000411", "published": True,
                "index_intent_id": INDEX_ID, "approval_state": "published"}

    monkeypatch.setattr(ri, "_approval_on", lambda: True)
    monkeypatch.setattr(ri, "_stated_through_approval", stated)
    show(tctx, ask_reply())
    out = call(tctx, silence())
    assert seen == [(DRAFT, "message")]
    assert out["publish_via"] == "open_draft" and out["source"] == "message"
    assert drafts(ri) == []


# --------------------------------------------------------------------------
# Which spans an ask opens
# --------------------------------------------------------------------------


@pytest.mark.parametrize("reply,draft", [
    (ask_reply(), DRAFT),
    (f"Here's a draft.\n\n“{DRAFT}”\n\n{ASK}", DRAFT),
    (f"«{DRAFT}»\n{ASK}", DRAFT),
    (f"> {DRAFT}\n\n{ASK}", DRAFT),
    (f"- {DRAFT}\n\n{ASK}", DRAFT),
    (f"*{DRAFT}*\n\n{ASK}", DRAFT),
    (f"**{DRAFT}**\n\n{ASK}", DRAFT),
    (f"{DRAFT}\n\n{ASK}", DRAFT),
    (f"{DRAFT}. {ASK}", DRAFT + "."),
    (f"Meet founders building on Solana in Goa,\nand researchers in Pune\n\n{ASK}",
     "Meet founders building on Solana in Goa,\nand researchers in Pune"),
    (f'"Meet founders building on Solana in Goa,\nand researchers in Pune"\n\n{ASK}',
     "Meet founders building on Solana in Goa,\nand researchers in Pune"),
])
def test_the_draft_is_one_of_the_spans(ri, reply, draft):
    candidates = ri.draft_candidates(reply)
    assert draft in candidates
    # Every span is an exact substring of the reply, and none is the question.
    assert all(c in reply and ASK not in c for c in candidates)


@pytest.mark.parametrize("draft", [
    "Meet *founders* building on Solana in Goa",
    "Meet founders_building on Solana in Goa",
    "Meet founders building on [Solana](https://solana.com) in Goa",
    "Meet founders building on `Solana` in Goa",
    "Meet founders building on Solana in Goa ~~or Pune~~",
    "Meet founders building on Solana in Goa || spoiler",
    "Meet C# founders in Goa",
    "Meet R&D founders in Goa",
    "Meet founders <b>building</b> in Goa",
    "Meet founders building on Solana in ‮aoG",  # a bidi override
    "Meet founders building​ on Solana in Goa",  # zero width
    "Meet founders building\ton Solana in Goa",
    "Here is my draft:",
    "MEDIA:/tmp/x.png Meet founders",
])
def test_a_span_that_would_not_render_as_its_bytes_is_not_opened(ri, draft):
    assert draft not in ri.draft_candidates(f'"{draft}"\n\n{ASK}')
    assert draft not in ri.draft_candidates(f"{draft}\n\n{ASK}")


def test_spans_are_capped(ri):
    reply = "\n".join(f'"Meet people number {n} in Goa"' for n in range(50)) + "\n" + ASK
    assert len(reply) <= ri.MAX_ASK_REPLY_CHARS
    assert len(ri.draft_candidates(reply)) == ri.MAX_DRAFT_CANDIDATES
    assert ri.draft_candidates("x" * 700 + "\n" + ASK) == []


# --------------------------------------------------------------------------
# The probe table (the refuter's cases)
# --------------------------------------------------------------------------


def test_the_probe_table_is_well_formed():
    expects = {"published", "held_cron", "held_unknown", "held_silence"}
    assert len({p["name"] for p in PROBES["probes"]}) == len(PROBES["probes"])
    for probe in PROBES["probes"]:
        assert probe["expect"] in expects
        assert probe["shown_by"] in ("telegram", "cron", None)
        assert probe["session"] in ("cron", "unknown", "telegram")


@pytest.mark.parametrize("probe", PROBES["probes"], ids=lambda p: p["name"])
def test_every_probe(tctx, ri, index, clock, av, plugin, probe):
    if probe["shown_by"] == "telegram":
        show(tctx, PROBES["shown"])
    elif probe["shown_by"] == "cron":
        show(tctx, PROBES["shown"], session=CRON, platform="cron")
    if probe["resident_turn"]:
        resident_says(tctx, "Something else entirely.")
    clock.now = T0 + probe["age_s"]
    args: dict[str, Any] = {"text": probe["text"], "source": "message"}
    if probe["marker"] is not None:
        args["confirmed_in_chat"] = probe["marker"]
    session = {"cron": CRON, "unknown": "never-seen", "telegram": SESSION}[probe["session"]]
    out = call(tctx, args, session=session)
    [event] = intention_events(av, plugin)
    if probe["expect"] == "published":
        assert out["published"] is True and out["source"] == "message" and out["publish_via"] == "open_draft"
        assert [r["body"]["description"] for r in index.requests] == [probe["text"]]
        assert event["payload"]["publish_via"] == "open_draft"
    else:
        assert out["published"] is False and out["source"] == "ambient"
        assert out["publish_refused"] == probe["expect"] and "publish_via" not in out
        assert index.requests == []
        assert event["payload"]["publish_refused"] == probe["expect"]
        assert "publish_via" not in event["payload"]
