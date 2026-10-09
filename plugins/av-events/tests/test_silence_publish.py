"""DATA-411: a silence capture from a cron send publishes only the exact draft
the resident already saw.

At the one ask the tool's own `post_llm_call` listener opens a draft in the
process's memory (never a file, which anything in the sandbox could forge),
only from a root session that R10 says a person is speaking in, and only when
the reply shows exactly one draft: one `> ` quote block directly above
"Should I publish this as written?" on its own line (fix round 1, M2). The
entry is the sha256 of the draft's exact bytes, when, and the session and
platform. Every open ask is closed by anything the gateway receives from a chat
(`pre_gateway_dispatch`, `gateway_platform_event`: fix round 1, M1) and by any
model turn but a real cron run's (`pre_llm_call`). A capture passed as
`message` with `confirmed_in_chat=silence` that R10 holds as `held_cron`, from
a chain whose root was seen on platform `cron` (S3), publishes as stated only
when its exact text is an open ask's draft, shown between
`SILENCE_PUBLISH_MIN_AGE_MINUTES` (S1) and `SILENCE_PUBLISH_WINDOW_HOURS` ago;
the ask is closed first (once only), and only a capture that then publishes
carries the trace (S4). Everything else stays exactly as before. Index is faked
in-process; no test reaches the network.

Mutants (one at a time, see the lane report): (a) no window check, killed by
`test_a_stale_draft_is_held`; (b) no close on use, killed by
`test_the_same_capture_again_is_held_cron`; (c) the capture's text stripped
before hashing, killed by `test_a_one_byte_edit_is_held`; (d) the open from a
cron lineage, killed by `test_a_cron_or_delegated_ask_opens_nothing`; (e) no
close on a resident turn, killed by `test_a_resident_turn_closes_every_open_draft`;
(f) no minimum age, killed by `test_a_stale_draft_is_held`; (g) no root-cron
check in the pass, killed by `test_a_cron_prefix_alone_never_passes`; (h) no
gateway closers, killed by `test_anything_the_gateway_receives_closes_every_open_ask`;
(x) the closer returns when the lineage check raises, killed by
`test_a_lineage_check_that_raises_still_closes`.
"""

from __future__ import annotations

import builtins
import io
import json
import os
import re
import sys
import threading
import urllib.parse
from pathlib import Path
from typing import Any, Callable

import pytest

SESSION = "sess-ask"
CRON = "cron_evening_20261009_180000"
KEY = "index-key-for-silence-publish-tests-0123456789"
INDEX_ID = "9b2f0c1e-0000-4000-8000-00000000d411"
DRAFT = "Meet founders building on Solana in Goa"
OTHER = "Find a climbing partner in Goa on weekends"
ASK = "Should I publish this as written?"
T0 = 1_791_000_000.0
HOUR = 3600.0
#: `show` opens the ask an hour before the clock's now, past the minimum age.
ASKED = T0 - HOUR
PROBES = json.loads((Path(__file__).parent / "vectors" / "silence_publish_probes.json").read_text(encoding="utf-8"))


def ask_reply(draft: str = DRAFT) -> str:
    return f"Here is how I would put it:\n\n> {draft}\n\n{ASK}"


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
        self.clock: Any = None

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
    """The plugin registered and live, the tool on, in a Telegram session, and a
    cron run Hermes started on platform `cron`."""
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("INDEX_API_KEY", KEY)
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = ToolFireCtx()
    ctx.clock = clock
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    ctx.fire("on_session_start", session_id=CRON, model="m", platform="cron")
    return ctx


def show(ctx: ToolFireCtx, reply: Any, *, session: str = SESSION, platform: Any = "telegram",
         ago: float = HOUR) -> None:
    """The agent's reply at the end of a turn, as Hermes fires it, `ago`
    seconds before the clock's now."""
    clock = ctx.clock
    now = clock.now
    clock.now = now - ago
    try:
        ctx.fire("post_llm_call", session_id=session, task_id="t", turn_id="u", user_message="hi",
                 assistant_response=reply, conversation_history=[], model="m", platform=platform)
    finally:
        clock.now = now


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


def test_the_constants(ri):
    assert ri.ASK_QUESTION == ASK and ASK in ri.DRAFT_RULE
    assert ri.SILENCE_PUBLISH_WINDOW_HOURS == 24 and ri.SILENCE_PUBLISH_MIN_AGE_MINUTES == 30
    assert ri.MAX_OPEN_DRAFTS == 20 and ri.DRAFT_LINE_PREFIX == "> "


def test_the_listeners_are_registered_with_the_tool_and_only_then(plugin, ri, tctx, monkeypatch):
    for name, listener in ri.DRAFT_HOOKS.items():
        assert listener in tctx.hooks[name]
    assert set(ri.DRAFT_HOOKS) == {"pre_gateway_dispatch", "gateway_platform_event", "pre_llm_call", "post_llm_call"}
    monkeypatch.setenv("AV_RECORD_INTENTION", "0")
    off = ToolFireCtx()
    monkeypatch.setattr(plugin, "_REGISTERED", False)
    plugin.register(off)
    for name, listener in ri.DRAFT_HOOKS.items():
        assert listener not in off.hooks.get(name, [])


@pytest.mark.parametrize("refused", ["pre_gateway_dispatch", "gateway_platform_event", "pre_llm_call"])
def test_without_every_closer_the_opener_is_never_registered(plugin, ri, index, clock, home, monkeypatch, refused):
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("INDEX_API_KEY", KEY)

    class Refusing(ToolFireCtx):
        def register_hook(self, hook_name, callback):  # noqa: ANN001
            if hook_name == refused and callback is ri.DRAFT_HOOKS[refused]:
                raise RuntimeError("no")
            return super().register_hook(hook_name, callback)

    ctx = Refusing()
    plugin.register(ctx)
    assert ri.DRAFT_HOOKS["post_llm_call"] not in ctx.hooks.get("post_llm_call", [])
    assert "record_intention" in ctx.tools


def test_a_human_facing_ask_opens_a_draft(tctx, ri, clock):
    show(tctx, ask_reply())
    [entry] = drafts(ri)
    assert entry["hash"] == ri.draft_hash(DRAFT)
    assert entry["shown_at"] == ri._iso(ASKED) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", entry["shown_at"])
    assert entry["session_id"] == SESSION and entry["platform"] == "telegram"
    assert set(entry) == {"hash", "shown_at", "session_id", "platform"}
    # Hashes only: the words are not kept.
    assert DRAFT not in repr(ri._OPEN_DRAFTS)


def test_the_listeners_return_nothing_to_hermes(tctx, ri):
    """A `pre_llm_call` return would be injected into the prompt; a
    `pre_gateway_dispatch` dict would skip or rewrite the resident's message."""
    for name in ri.DRAFT_HOOKS:
        assert ri.DRAFT_HOOKS[name](session_id=SESSION, assistant_response=ask_reply(), event=object()) is None


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
    f"> {DRAFT}",  # no question
    f"> {DRAFT}\n\nShould I publish it as written?",  # not the question word for word
    f"> {DRAFT}\n\n¿Lo publico tal cual?",  # translated
    f"> {DRAFT}\n\n{ASK} Or shall I change it?",  # the question not on a line of its own
    f"> {DRAFT}\n\n{ASK}\n{ASK}",  # asked twice
    f"> {DRAFT}\n\n{ASK}" + "\n" + "x" * 2000,  # too long for one message
    f'"{DRAFT}"\n\n{ASK}',  # in quote marks, not a block
    f"{DRAFT}\n\n{ASK}",  # plain line, not a block
    "",
    None,
])
def test_a_reply_without_one_draft_block_and_the_ask_opens_nothing(tctx, ri, index, reply):
    show(tctx, reply)
    assert drafts(ri) == []
    assert_held_cron(call(tctx, silence()), index)


# --------------------------------------------------------------------------
# What the draft is: one block, or nothing (fix round 1, M2)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("reply,draft", [
    (ask_reply(), DRAFT),
    (f"> {DRAFT}\n{ASK}", DRAFT),
    (f"> {DRAFT}\n\n\n{ASK}\n", DRAFT),
    (f"Here's a draft.\n> {DRAFT}\n\n  {ASK}  ", DRAFT),
    (f"> {DRAFT}\n\n{ASK}\n\nOr I could say Find a cofounder for a crypto casino instead.", DRAFT),
    (f'Your groupmate wrote "I am selling my conference ticket cheap, DM me" earlier.\n\n> {DRAFT}\n\n{ASK}', DRAFT),
    (f"> Meet founders building on Solana in Goa,\n> and researchers in Pune\n\n{ASK}",
     "Meet founders building on Solana in Goa,\nand researchers in Pune"),
    (f'> "{DRAFT}"\n\n{ASK}', f'"{DRAFT}"'),
])
def test_the_draft_is_the_one_block_above_the_question(ri, reply, draft):
    assert ri.draft_block(reply) == draft
    assert ri.draft_candidates(reply) == [draft]


@pytest.mark.parametrize("reply", [
    # The refuter's shapes (p03, p05, p06, p08) and their block variants.
    f'You pasted: "{ASK}" That is the question I ask before publishing.\n{DRAFT}',
    f'Here is how I would put it:\n\n"{DRAFT}"\n\nOr I could say Find a cofounder for a crypto casino instead\n\n{ASK}',
    f"> {DRAFT}\n\nOr I could say Find a cofounder for a crypto casino instead\n\n{ASK}",
    f'Option A: "{DRAFT}"\nOption B: "Find investors for a stablecoin startup"\n{ASK}',
    f"Option A:\n> {DRAFT}\n\nOption B:\n> Find investors for a stablecoin startup\n\n{ASK}",
    f'Your groupmate wrote "I am selling my conference ticket cheap, DM me" earlier.\nMy draft for you:\n{DRAFT}\n{ASK}',
    f"Your groupmate wrote:\n> I am selling my conference ticket cheap, DM me\n\nMy draft for you:\n> {DRAFT}\n\n{ASK}",
    f"Your groupmate wrote:\n> I am selling my conference ticket cheap, DM me\n\nMy draft: {DRAFT}\n\n{ASK}",
    # A block after the question, a block of another shape, three lines.
    f"{ASK}\n\n> {DRAFT}",
    f">> {DRAFT}\n\n{ASK}",
    f">{DRAFT}\n\n{ASK}",
    f"  > {DRAFT}\n\n{ASK}",
    f"**> {DRAFT}||\n\n{ASK}",
    f"> {DRAFT}\n> and researchers in Pune\n> and Delhi\n\n{ASK}",
    f"> {DRAFT}\n>\n> and researchers in Pune\n\n{ASK}",
    f"> Here is my draft:\n\n{ASK}",
])
def test_anything_but_one_block_above_the_question_opens_nothing(ri, reply):
    assert ri.draft_block(reply) is None and ri.draft_candidates(reply) == []


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
    "Meet founders building on Solana in \u202eaoG",  # a bidi override
    "Meet founders building\u200b on Solana in Goa",  # zero width
    "Meet founders building\ton Solana in Goa",
    "Meet founders building on Solana in Goa\r",
    "MEDIA:/tmp/x.png Meet founders",
    "x" * 601,
])
def test_a_block_that_would_not_render_as_its_bytes_is_not_opened(ri, draft):
    assert ri.draft_block(f"> {draft}\n\n{ASK}") is None


# --------------------------------------------------------------------------
# The pass
# --------------------------------------------------------------------------


def test_a_cron_silence_capture_of_the_shown_draft_publishes_and_closes_it(tctx, ri, index, clock, av, plugin):
    show(tctx, ask_reply())
    clock.now = T0 + 3 * HOUR
    out = call(tctx, silence())
    assert out["success"] is True and out["published"] is True
    assert out["source"] == "message" and out["confirmed_in_chat"] == "silence"
    assert out["intention_id"] == INDEX_ID and out["index_intent_id"] == INDEX_ID
    assert out["publish_via"] == "open_draft" and out["draft_shown_at"] == ri._iso(ASKED)
    assert "publish_refused" not in out and "held" not in out
    # The exact bytes, sent as they are.
    assert [r["body"]["description"] for r in index.requests] == [DRAFT]
    # Closed before the publish went on.
    assert drafts(ri) == []
    # The event says how it passed. The observer's own cron check keeps the
    # restrictive source on the event (the more restrictive of the two wins).
    [event] = intention_events(av, plugin)
    payload = event["payload"]
    assert payload["publish_via"] == "open_draft" and payload["draft_shown_at"] == ri._iso(ASKED)
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


@pytest.mark.parametrize("age,passes", [
    (0, False), (60, False), (30 * 60 - 1, False),  # mutant (f): the hourly run at :20, seconds after the ask
    (30 * 60, True), (HOUR, True), (24 * HOUR, True),
    (24 * HOUR + 1, False), (72 * HOUR, False), (-1, False),  # mutant (a); a clock set back
])
def test_a_stale_draft_is_held(tctx, ri, index, clock, age, passes):
    """Mutants (a) no window and (f) no minimum age are killed here. A draft
    from the future (a clock set back) is not fresh either."""
    show(tctx, ask_reply(), ago=0)
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
    DRAFT.replace(" ", "\u00a0", 1), DRAFT.replace("Goa", "Bangalore"), DRAFT[:-1], DRAFT + "\u200b",
    "> " + DRAFT,
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
        assert "publish_via" not in out and index.requests == []
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


@pytest.mark.parametrize("platform", [None, "api_server", "telegram"])
def test_a_cron_prefix_alone_never_passes(tctx, ri, index, platform):
    """S3 (probe p04): a `cron_` id never seen on platform `cron` (an
    api_server client may choose its session id) is held_cron as before, gets
    no pass, and its own turn closes the asks. Mutant (g) is killed here."""
    sid = "cron_from_api"
    if platform is not None:
        tctx.fire("on_session_start", session_id=sid, model="m", platform=platform)
    assert ri.held_reason(sid) == "cron" and ri.cron_root(sid) is False
    show(tctx, ask_reply())
    assert_held_cron(call(tctx, silence(), session=sid), index)
    assert len(drafts(ri)) == 1
    resident_says(tctx, "hello", session=sid, platform=platform or "")
    assert drafts(ri) == []


def test_a_subagent_of_a_real_cron_run_passes(tctx, ri, index):
    tctx.fire("subagent_start", child_session_id="cron-child", parent_session_id=CRON)
    tctx.fire("pre_api_request", session_id="cron-child", platform="subagent", model="m")
    assert ri.cron_root("cron-child") is True
    show(tctx, ask_reply())
    resident_says(tctx, "work", session="cron-child", platform="subagent")  # a cron child's turn does not close
    assert call(tctx, silence(), session="cron-child")["published"] is True


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
    show(tctx, ask_reply(DRAFT), ago=2 * HOUR)
    show(tctx, ask_reply(OTHER))
    out = call(tctx, silence(OTHER))
    assert out["published"] is True and out["draft_shown_at"] == ri._iso(ASKED)
    [left] = drafts(ri)
    assert left["hash"] == ri.draft_hash(DRAFT) and left["shown_at"] == ri._iso(T0 - 2 * HOUR)
    out = call(tctx, silence(DRAFT), tool_call_id="c2")
    assert out["published"] is True and out["draft_shown_at"] == ri._iso(T0 - 2 * HOUR)
    assert drafts(ri) == []


def test_the_same_words_in_two_asks_pass_once(tctx, ri, index, clock):
    show(tctx, ask_reply(), ago=2 * HOUR)
    show(tctx, f"> {DRAFT}\n\n{ASK}")
    assert call(tctx, silence())["published"] is True
    assert drafts(ri) == []
    index.requests.clear()
    assert_held_cron(call(tctx, silence(), tool_call_id="c2"), index)


def test_the_state_is_bounded_at_twenty_oldest_dropped(tctx, ri, index, clock):
    texts = [f"Meet people working on project {n} in Goa" for n in range(25)]
    for n, text in enumerate(texts):
        show(tctx, ask_reply(text), ago=2 * HOUR - n)
    kept = drafts(ri)
    assert len(kept) == 20
    assert [d["shown_at"] for d in kept] == [ri._iso(T0 - 2 * HOUR + n) for n in range(5, 25)]
    assert_held_cron(call(tctx, silence(texts[0])), index)
    assert call(tctx, silence(texts[5]), tool_call_id="c2")["published"] is True


# --------------------------------------------------------------------------
# Closing (fix round 1, M1 and S5)
# --------------------------------------------------------------------------


def test_a_resident_turn_closes_every_open_draft(tctx, ri, index):
    """Whatever they said (a no included), it was not silence."""
    show(tctx, ask_reply())
    resident_says(tctx, "No, don't post that.")
    assert drafts(ri) == []
    assert_held_cron(call(tctx, silence()), index)


class Event:
    """The bits of a Hermes `MessageEvent` the gateway would pass."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.internal = False


@pytest.mark.parametrize("hook,kwargs", [
    # A Telegram reaction (thumbs down): only a gateway_platform_event, no model turn.
    ("gateway_platform_event", {"platform": "telegram", "event_type": "reaction",
                                "payload": {"emojis": ["\U0001f44e"], "custom_emoji_ids": [], "chat_id": 1, "message_id": 2}}),
    # The resident edits a message.
    ("gateway_platform_event", {"platform": "telegram", "event_type": "message_edited", "payload": {}}),
    # /stop and /new: an inbound message, handled as a command, no model turn.
    ("pre_gateway_dispatch", {"event": Event("/stop"), "gateway": None, "session_store": None}),
    ("pre_gateway_dispatch", {"event": Event("/new"), "gateway": None, "session_store": None}),
    # A plain message, closed before auth, voice transcription, compaction or any model turn.
    ("pre_gateway_dispatch", {"event": Event("hmm, let me think"), "gateway": None, "session_store": None}),
    # Anything else the gateway hands over, however little it carries.
    ("pre_gateway_dispatch", {}),
])
def test_anything_the_gateway_receives_closes_every_open_ask(tctx, ri, index, hook, kwargs):
    """M1 (probe p10): an answer that is not a model turn is not silence. Mutant (h)."""
    show(tctx, ask_reply(), ago=2 * HOUR)
    show(tctx, ask_reply(OTHER))
    results = tctx.fire(hook, **kwargs)
    assert drafts(ri) == []
    # No listener answers the gateway (a dict would skip or rewrite the message).
    assert ri.DRAFT_HOOKS[hook](**kwargs) is None
    assert results == [None]
    assert_held_cron(call(tctx, silence()), index)


def test_a_cron_run_never_reaches_the_gateway_closers(tctx, ri, index):
    """A cron run's own turn does not close (it is the send the silence is for)."""
    show(tctx, ask_reply())
    resident_says(tctx, "Run the evening digest.", session=CRON, platform="cron")
    assert len(drafts(ri)) == 1
    assert call(tctx, silence())["published"] is True


def test_an_unknown_turn_closes_drafts_fail_closed(tctx, ri, index):
    show(tctx, ask_reply())
    resident_says(tctx, "webhook payload", session="never-seen", platform="")
    assert drafts(ri) == []


def test_a_lineage_check_that_raises_still_closes(tctx, ri, index, monkeypatch):
    """S5, mutant (x): when the lineage check raises, the closer closes."""
    show(tctx, ask_reply())

    def boom(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("lineage unreadable")

    monkeypatch.setattr(ri, "held_reason", boom)
    resident_says(tctx, "Run the evening digest.", session=CRON, platform="cron")
    assert ri._OPEN_DRAFTS == []


def test_a_lineage_check_that_raises_never_passes(tctx, ri, index, monkeypatch):
    show(tctx, ask_reply())
    monkeypatch.setattr(ri, "cron_root", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("x")))
    assert_held_cron(call(tctx, silence()), index)


def test_a_new_ask_after_a_resident_turn_opens_again(tctx, ri, index, clock):
    show(tctx, ask_reply(OTHER), ago=2 * HOUR)
    resident_says(tctx, "Hmm, something about Solana instead?")
    show(tctx, ask_reply())
    [entry] = drafts(ri)
    assert entry["shown_at"] == ri._iso(ASKED)
    assert call(tctx, silence())["published"] is True


# --------------------------------------------------------------------------
# The trace only on a publish (fix round 1, S4)
# --------------------------------------------------------------------------


def test_a_draft_taken_then_refused_carries_no_trace(tctx, ri, index, monkeypatch, av, plugin):
    """Probe p13: no key. The draft is used up (D3) and the result says only no_key."""
    show(tctx, ask_reply())
    monkeypatch.delenv("INDEX_API_KEY")
    out = call(tctx, silence())
    assert out["published"] is False and out["publish_refused"] == "no_key"
    assert "publish_via" not in out and "draft_shown_at" not in out
    assert "publish_via" not in intention_events(av, plugin)[0]["payload"]
    assert drafts(ri) == []
    monkeypatch.setenv("INDEX_API_KEY", KEY)
    assert_held_cron(call(tctx, silence(), tool_call_id="c2"), index)


def test_a_draft_taken_then_held_ambient_exists_carries_no_trace(tctx, ri, index, clock, av, plugin):
    """Probe p19: an earlier held capture of the same words keeps them off Index."""
    show(tctx, ask_reply(), ago=0)
    clock.now = T0 + 60  # too soon: held_cron, and its fingerprint is kept
    assert call(tctx, silence())["publish_refused"] == "held_cron"
    clock.now = T0 + HOUR
    out = call(tctx, silence(), tool_call_id="c2")
    assert out["published"] is False and out["publish_refused"] == "held_ambient_exists"
    assert "publish_via" not in out and "draft_shown_at" not in out
    assert "publish_via" not in intention_events(av, plugin)[1]["payload"]
    assert index.requests == [] and drafts(ri) == []


def test_through_approval_the_pass_is_a_stated_capture(tctx, ri, index, monkeypatch):
    """With approval.md on, the pass goes where any stated capture goes, and
    the trace follows the outcome."""
    seen: list[tuple[str, str]] = []
    outcome = {"published": True}

    def stated(result: dict, text: str, source: str) -> dict:
        seen.append((text, source))
        return {**result, "intention_id": "0199aaaa-0000-7000-8000-000000000411", "published": outcome["published"],
                "index_intent_id": INDEX_ID if outcome["published"] else None, "approval_state": "published"}

    monkeypatch.setattr(ri, "_approval_on", lambda: True)
    monkeypatch.setattr(ri, "_stated_through_approval", stated)
    show(tctx, ask_reply())
    out = call(tctx, silence())
    assert seen == [(DRAFT, "message")]
    assert out["publish_via"] == "open_draft" and out["source"] == "message"
    assert drafts(ri) == []
    outcome["published"] = False
    show(tctx, ask_reply(OTHER))
    out = call(tctx, silence(OTHER), tool_call_id="c2")
    assert seen[-1] == (OTHER, "message") and "publish_via" not in out


# --------------------------------------------------------------------------
# The open asks live in memory only (fix round 0)
# --------------------------------------------------------------------------


def test_the_open_drafts_never_touch_a_file(tctx, ri, index, clock, monkeypatch, home):
    """Anything in the sandbox can write a file under $HERMES_HOME, so the
    open asks live in memory only. Opening, taking and closing never open,
    write, rename or create a path."""
    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError(f"file access on the open-draft path: {args[:1]!r}")

    with monkeypatch.context() as m:
        for target, name in ((builtins, "open"), (os, "open"), (os, "replace"), (os, "rename"),
                             (os, "makedirs"), (os, "mkdir"), (os, "unlink"), (os, "stat")):
            m.setattr(target, name, refuse)
        assert ri.note_ask(SESSION, "telegram", ask_reply()) == 1
        clock.now = T0 + HOUR
        assert ri.take_open_draft(DRAFT) == ri._iso(T0)
        assert ri.note_ask(SESSION, "telegram", ask_reply(OTHER)) == 1
        ri.close_open_drafts(SESSION)
        assert ri.note_ask(SESSION, "telegram", ask_reply(OTHER)) == 1
        ri.close_all_open_drafts()
    assert ri._OPEN_DRAFTS == []
    # A full ask -> cron pass through the hooks and the tool leaves no draft file.
    show(tctx, ask_reply())
    assert call(tctx, silence())["published"] is True
    assert [p for p in Path(home).rglob("*") if "draft" in p.name] == []


def test_a_forged_drafts_file_opens_nothing(tctx, ri, index, home):
    """The attack the file design allowed: a cron session's terminal writes an
    "open ask" for any text, then captures it with silence. Held."""
    forged = {"v": 1, "drafts": [{"hashes": [ri.draft_hash(DRAFT)], "hash": ri.draft_hash(DRAFT),
                                  "shown_at": ri._iso(ASKED), "session_id": SESSION, "platform": "telegram"}]}
    for name in ("open_drafts.json", "drafts.json"):
        target = Path(home) / "av-events" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(forged), encoding="utf-8")
    assert_held_cron(call(tctx, silence()), index)


def test_a_restart_between_the_ask_and_the_cron_send_holds_it(tctx, ri, index):
    """A gateway restart loses the open asks (memory only): fail closed."""
    show(tctx, ask_reply())
    assert len(drafts(ri)) == 1
    with ri._DRAFTS_LOCK:
        ri._OPEN_DRAFTS.clear()  # what a fresh process starts with
    assert_held_cron(call(tctx, silence()), index)


def test_a_reloaded_module_starts_with_no_open_draft(ri):
    assert ri._OPEN_DRAFTS == [] and ri.take_open_draft(DRAFT) is None


# --------------------------------------------------------------------------
# The probe table (the refuter's cases)
# --------------------------------------------------------------------------


def test_the_probe_table_is_well_formed():
    expects = {"published", "held_cron", "held_unknown", "held_silence"}
    assert len({p["name"] for p in PROBES["probes"]}) == len(PROBES["probes"])
    for probe in PROBES["probes"]:
        assert probe["expect"] in expects
        assert probe["shown_by"] in ("telegram", "cron", None)
        assert probe["session"] in ("cron", "cron_prefix_only", "unknown", "telegram")


@pytest.mark.parametrize("probe", PROBES["probes"], ids=lambda p: p["name"])
def test_every_probe(tctx, ri, index, clock, av, plugin, probe):
    shown = probe.get("shown", PROBES["shown"])
    if probe["shown_by"] == "telegram":
        show(tctx, shown, ago=0)
    elif probe["shown_by"] == "cron":
        show(tctx, shown, session=CRON, platform="cron", ago=0)
    if probe["resident_turn"]:
        resident_says(tctx, "Something else entirely.")
    clock.now = T0 + probe["age_s"]
    args: dict[str, Any] = {"text": probe["text"], "source": "message"}
    if probe["marker"] is not None:
        args["confirmed_in_chat"] = probe["marker"]
    session = {"cron": CRON, "cron_prefix_only": "cron_prefix_only_1", "unknown": "never-seen",
               "telegram": SESSION}[probe["session"]]
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
