"""av-vote: the vote card's callback buttons record the vote in the chat (VOTE CALLBACK, rc42)."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import sys
import threading
import types
import urllib.error
import urllib.request

import pytest

OWNER = "123456789"
OTHER = "987654321"
TENANT = "0b3c2a1f-aaaa-bbbb-cccc-1234567890ab"
TOKEN = "AQ" + "x7_-Zz09" * 5 + "ab"  # 44 base64url characters, like the app's 0x01||HMAC token
TOKEN_B = "AQ" + "Kk8_-mN1" * 5 + "cd"
assert len(TOKEN) == 44 and len(TOKEN_B) == 44

CORE_CALLBACKS = [
    "ea:once:17", "ea:deny:3", "cl:2:abc", "mp:anthropic", "mpg:1", "mpv:2", "mm:x", "mc:y", "mb", "mx", "mg:z",
    "cp:fast:on", "sc:yes:1", "gt:archive:1", "update_prompt:yes",
]


# --------------------------------------------------------------------------- fakes

class Button:
    def __init__(self, text, callback_data=None, url=None):
        self.text, self.callback_data, self.url = text, callback_data, url

    def __repr__(self):
        return f"Button({self.text!r}, {self.callback_data!r}, {self.url!r})"


class Markup:
    def __init__(self, rows):
        self.inline_keyboard = rows


class Query:
    def __init__(self, data, user=OWNER, chat=OWNER, rows=None, message_id=42, answer_raises=False):
        self.data = data
        self.from_user = types.SimpleNamespace(id=int(user))
        self.message = types.SimpleNamespace(
            chat=types.SimpleNamespace(id=int(chat)), message_id=message_id,
            reply_markup=Markup(rows) if rows is not None else None)
        self.answers: list[str] = []
        self.edits: list[object] = []
        self._answer_raises = answer_raises

    async def answer(self, text=None, **_):
        if self._answer_raises:
            raise RuntimeError("query too old")
        self.answers.append(text)

    async def edit_message_reply_markup(self, reply_markup=None, **_):
        self.edits.append(reply_markup)


def card(selected=None):
    rows = [[Button(("✅ " if selected == i else "") + label, callback_data=f"avv:{i}:{tok}")]
            for i, (label, tok) in enumerate((("Yes", TOKEN), ("No", TOKEN_B)))]
    web = [Button("Vote on the web", url="https://agents.edgecity.live/referenda/r1")]
    return rows + [web]


def update(query):
    return types.SimpleNamespace(callback_query=query)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def owner_env(monkeypatch):
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OWNER)
    monkeypatch.setenv("AV_TENANT_ID", TENANT)


def handler(plugin, record, adapter=None, **kw):
    return plugin.make_handler(adapter, make_button=lambda t, d: Button(t, callback_data=d),
                               make_markup=Markup, record=record, **kw)


class Recorder:
    def __init__(self, result=("recorded", None), raises=None, gate=None):
        self.result, self.raises, self.gate = result, raises, gate
        self.tokens: list[str] = []

    def __call__(self, token):
        self.tokens.append(token)
        if self.gate is not None:
            self.gate.wait(5)
        if self.raises:
            raise self.raises
        return self.result


# --------------------------------------------------------------------------- callback_data format

def test_parse_accepts_the_contract_format(plugin):
    assert plugin.parse_callback(f"avv:0:{TOKEN}") == (0, TOKEN)
    assert plugin.parse_callback(f"avv:11:{TOKEN}") == (11, TOKEN)
    assert plugin.parse_callback(f"avv:3:{TOKEN[:43]}") == (3, TOKEN[:43])  # the cp draft's 43 too


@pytest.mark.parametrize("data", [
    f"avv:12:{TOKEN}", f"avv:01:{TOKEN}", f"avv:-1:{TOKEN}", f"avv:1:{TOKEN}A", f"avv:1:{TOKEN[:42]}",
    f"avv:1:{TOKEN[:-1]}=", f"avv:1:{TOKEN[:-1]}.", "avv:", "avv:1", f"AVV:1:{TOKEN}", f" avv:1:{TOKEN}",
    f"avv:1:{TOKEN}\n", None, 7, "",
])
def test_parse_refuses_anything_else(plugin, data):
    assert plugin.parse_callback(data) is None


def test_callback_data_fits_telegrams_64_bytes(plugin):
    longest = f"avv:{plugin.MAX_OPTION_INDEX}:{TOKEN}"
    assert plugin.parse_callback(longest) is not None
    assert len(longest.encode("utf-8")) == 51 <= plugin.CALLBACK_DATA_MAX_BYTES == 64
    # A value over 64 bytes is refused before the pattern is even tried.
    assert plugin.parse_callback("avv:1:" + "A" * 60) is None


@pytest.mark.parametrize("data", CORE_CALLBACKS)
def test_handler_pattern_never_matches_core_callbacks(plugin, data):
    assert re.match(plugin.HANDLER_PATTERN, data) is None
    assert re.match(plugin.HANDLER_PATTERN, f"avv:0:{TOKEN}")


# --------------------------------------------------------------------------- registration

def test_register_wires_one_scoped_telegram_factory(plugin):
    calls = []
    ctx = types.SimpleNamespace(register_platform_handler=lambda p, f: calls.append((p, f)))
    plugin.register(ctx)
    assert [p for p, _ in calls] == ["telegram"]


def test_register_never_raises(plugin):
    def boom(*_):
        raise ValueError("refused")
    plugin.register(types.SimpleNamespace(register_platform_handler=boom))
    plugin.register(types.SimpleNamespace())  # an old Hermes: nothing to wire


def test_factory_adds_a_pattern_scoped_callback_handler(plugin, monkeypatch):
    added = []

    class CallbackQueryHandler:
        def __init__(self, callback, pattern=None, block=True):
            self.callback, self.pattern, self.block = callback, pattern, block

    telegram = types.ModuleType("telegram")
    telegram.InlineKeyboardButton, telegram.InlineKeyboardMarkup = Button, Markup
    ext = types.ModuleType("telegram.ext")
    ext.CallbackQueryHandler = CallbackQueryHandler
    monkeypatch.setitem(sys.modules, "telegram", telegram)
    monkeypatch.setitem(sys.modules, "telegram.ext", ext)
    plugin._wire_telegram(types.SimpleNamespace(add_handler=added.append), object())
    assert len(added) == 1 and added[0].pattern == r"^avv:"
    assert added[0].block is False  # never holds the bot's one-at-a-time update loop (OV-358 S1)


# --------------------------------------------------------------------------- owner only

@pytest.fixture
def pairings(plugin, monkeypatch):
    """Hermes's approved Telegram pairings, as a set the test fills (empty: nobody paired)."""
    approved: set[str] = set()
    monkeypatch.setattr(plugin, "paired_on_box", lambda user: user in approved)
    return approved


@pytest.mark.parametrize("user,chat", [(OTHER, OWNER), (OTHER, OTHER), (OWNER, OTHER)])
def test_only_the_boxs_resident_can_vote(plugin, owner_env, pairings, user, chat):
    rec = Recorder()
    q = Query(f"avv:0:{TOKEN}", user=user, chat=chat, rows=card())
    run(handler(plugin, rec)(update(q)))
    assert q.answers == ["This vote card is not yours"]
    assert rec.tokens == [] and q.edits == []


def test_no_paired_owner_fails_closed(plugin, monkeypatch, pairings):
    monkeypatch.delenv("TELEGRAM_HOME_CHANNEL", raising=False)
    rec = Recorder()
    q = Query(f"avv:0:{TOKEN}", rows=card())
    run(handler(plugin, rec)(update(q)))
    assert q.answers == ["This vote card is not yours"] and rec.tokens == []


def test_pairing_store_unreadable_is_not_paired(plugin):
    # No Hermes here: gateway.pairing cannot be imported, so nobody is paired (fail closed).
    assert plugin.paired_on_box(OWNER) is False


def test_owner_ids_from_the_home_channel_and_env(plugin, monkeypatch):
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OTHER)
    home = types.SimpleNamespace(chat_id=OWNER, user_id="555")
    adapter = types.SimpleNamespace(config=types.SimpleNamespace(home_channel=home))
    assert plugin.owner_ids(adapter) == {OWNER, "555", OTHER}
    assert plugin.owner_ids(types.SimpleNamespace(config=types.SimpleNamespace(home_channel=None))) == {OTHER}
    group = types.SimpleNamespace(chat_id="-100123", user_id=None)
    assert plugin.owner_ids(types.SimpleNamespace(config=types.SimpleNamespace(home_channel=group))) == {OTHER}
    monkeypatch.delenv("TELEGRAM_HOME_CHANNEL")
    assert plugin.owner_ids(None) == set()


def test_home_channel_user_id_is_the_owner(plugin, monkeypatch, pairings):
    # A /sethome in a group: chat_id is negative, user_id is still the resident (OV-358 S2 b).
    monkeypatch.delenv("TELEGRAM_HOME_CHANNEL", raising=False)
    adapter = types.SimpleNamespace(config=types.SimpleNamespace(
        home_channel={"chat_id": "-100123", "user_id": OWNER}))
    q = Query(f"avv:0:{TOKEN}", rows=card())
    run(handler(plugin, Recorder(), adapter=adapter)(update(q)))
    assert q.answers == ["Recorded: Yes"]


def test_a_paired_resident_whose_home_drifted_can_vote_in_their_dm(plugin, owner_env, pairings):
    # TELEGRAM_HOME_CHANNEL is an old id (inherited env, re-pair); the card went to the paired id.
    pairings.add(OTHER)
    q = Query(f"avv:0:{TOKEN}", user=OTHER, chat=OTHER, rows=card())
    run(handler(plugin, Recorder())(update(q)))
    assert q.answers == ["Recorded: Yes"]


def test_pairing_never_lets_a_tap_through_outside_the_tappers_dm(plugin, owner_env, pairings):
    pairings.add(OTHER)
    for chat in (OWNER, "-100123"):
        q = Query(f"avv:0:{TOKEN}", user=OTHER, chat=chat, rows=card())
        run(handler(plugin, Recorder())(update(q)))
        assert q.answers == ["This vote card is not yours"]
    q = Query(f"avv:0:{TOKEN}", user=OTHER, chat=OTHER, rows=card())
    q.message.chat.type = "group"
    run(handler(plugin, Recorder())(update(q)))
    assert q.answers == ["This vote card is not yours"]
    q = Query(f"avv:0:{TOKEN}", user=OTHER, chat=OTHER, rows=card())
    q.message = None  # no chat to check: the pairing list alone is not enough
    run(handler(plugin, Recorder())(update(q)))
    assert q.answers == ["This vote card is not yours"]


# --------------------------------------------------------------------------- success / failure / timeout

def test_success_answers_and_marks_the_chosen_option(plugin, owner_env):
    rec = Recorder(("recorded", None))
    rows = card()
    q = Query(f"avv:1:{TOKEN_B}", rows=rows)
    run(handler(plugin, rec)(update(q)))
    assert rec.tokens == [TOKEN_B]
    assert q.answers == ["Recorded: No"]
    assert len(q.edits) == 1
    new = q.edits[0].inline_keyboard
    assert [b.text for b in (new[0][0], new[1][0])] == ["Yes", "✅ No"]
    assert new[1][0].callback_data == f"avv:1:{TOKEN_B}"
    assert new[0][0] is rows[0][0]  # the other option is untouched and still tappable
    assert new[2][0] is rows[2][0] and new[2][0].url  # the web row is kept as it is


def test_app_label_wins_and_a_changed_vote_moves_the_mark(plugin, owner_env):
    rec = Recorder(("recorded", "Yes, adopt it"))
    q = Query(f"avv:0:{TOKEN}", rows=card(selected=1))
    run(handler(plugin, rec)(update(q)))
    assert q.answers == ["Recorded: Yes, adopt it"]
    new = q.edits[0].inline_keyboard
    assert [new[0][0].text, new[1][0].text] == ["✅ Yes", "No"]


@pytest.mark.parametrize("outcome,text", [
    ("expired", "Voting has closed."),
    ("invalid", "This vote button is no longer valid; use the web link."),
    ("timeout", "Could not record your vote. Try again or use the web link on the card."),
    ("network", "Could not record your vote. Try again or use the web link on the card."),
    ("http_error", "Could not record your vote. Try again or use the web link on the card."),
    ("rate_limited", "Could not record your vote. Try again or use the web link on the card."),
    ("bad_response", "Could not record your vote. Try again or use the web link on the card."),
])
def test_failure_answers_and_leaves_the_card(plugin, owner_env, outcome, text):
    q = Query(f"avv:0:{TOKEN}", rows=card())
    run(handler(plugin, Recorder((outcome, None)))(update(q)))
    assert q.answers == [text] and q.edits == []


def test_a_hung_record_call_times_out(plugin, owner_env):
    gate = threading.Event()
    q = Query(f"avv:0:{TOKEN}", rows=card())
    try:
        run(handler(plugin, Recorder(gate=gate), timeout=0.05)(update(q)))
    finally:
        gate.set()
    assert q.answers == ["Could not record your vote. Try again or use the web link on the card."]
    assert q.edits == []


def test_bad_avv_data_is_refused_without_a_call(plugin, owner_env):
    rec = Recorder()
    q = Query("avv:99:short", rows=card())
    run(handler(plugin, rec)(update(q)))
    assert q.answers == ["This vote button is not valid."] and rec.tokens == []


def test_fail_open_on_any_exception(plugin, owner_env):
    q = Query(f"avv:0:{TOKEN}", rows=card())
    run(handler(plugin, Recorder(raises=RuntimeError("socket gone")))(update(q)))
    assert q.answers == ["Could not record your vote. Try again or use the web link on the card."]
    # An answer that itself fails (an expired query) never raises either.
    q2 = Query(f"avv:0:{TOKEN}", rows=card(), answer_raises=True)
    run(handler(plugin, Recorder(raises=RuntimeError("x")))(update(q2)))
    run(handler(plugin, Recorder())(types.SimpleNamespace(callback_query=None)))


def test_edit_failure_is_cosmetic(plugin, owner_env):
    q = Query(f"avv:0:{TOKEN}", rows=card())

    async def boom(**_):
        raise RuntimeError("message is not modified")
    q.edit_message_reply_markup = boom
    run(handler(plugin, Recorder())(update(q)))
    assert q.answers == ["Recorded: Yes"]


# --------------------------------------------------------------------------- idempotent

def test_double_tap_while_recording_sends_once(plugin, owner_env):
    gate = threading.Event()
    rec = Recorder(gate=gate)
    h = handler(plugin, rec)
    rows = card()
    first, second = Query(f"avv:0:{TOKEN}", rows=rows), Query(f"avv:0:{TOKEN}", rows=rows)

    async def both():
        task = asyncio.create_task(h(update(first)))
        while not rec.tokens:
            await asyncio.sleep(0.01)
        await h(update(second))
        gate.set()
        await task

    run(both())
    assert rec.tokens == [TOKEN]
    assert second.answers == ["Still recording your vote..."] and second.edits == []
    assert first.answers == ["Recorded: Yes"] and len(first.edits) == 1
    assert plugin._in_flight == set()


def test_a_repeat_tap_after_recording_is_the_same_vote(plugin, owner_env):
    rec = Recorder()
    q = Query(f"avv:0:{TOKEN}", rows=card(selected=0))
    run(handler(plugin, rec)(update(q)))
    assert q.answers == ["Recorded: Yes"]
    assert q.edits == []  # already marked: no edit, no "message is not modified"
    assert rec.tokens == [TOKEN]


# --------------------------------------------------------------------------- logs

def test_no_token_in_logs(plugin, owner_env, caplog):
    caplog.set_level(logging.DEBUG)
    for result in (("recorded", None), ("expired", None), ("network", None)):
        run(handler(plugin, Recorder(result))(update(Query(f"avv:0:{TOKEN}", rows=card()))))
    run(handler(plugin, Recorder(raises=RuntimeError(TOKEN)))(update(Query(f"avv:0:{TOKEN}", rows=card()))))
    run(handler(plugin, Recorder())(update(Query(f"avv:0:{TOKEN}", user=OTHER, rows=card()))))
    text = caplog.text
    assert TOKEN not in text and TOKEN[:16] not in text and OWNER not in text and OTHER not in text
    assert "tenant=0b3c2a1f outcome=recorded" in text
    assert "outcome=not_owner" in text and "outcome=handler_error" in text


# --------------------------------------------------------------------------- the app call

class Response:
    def __init__(self, status, body):
        self.status, self._body = status, body

    def read(self, n=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Opener:
    def __init__(self, status=200, body=b'{"ok":true,"state":"recorded","optionLabel":"Yes"}', raises=None):
        self.status, self.body, self.raises = status, body, raises
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        if self.raises:
            raise self.raises
        if self.status >= 400:
            raise urllib.error.HTTPError(request.full_url, self.status, "x", {}, io.BytesIO(self.body))
        return Response(self.status, self.body)


def test_record_vote_posts_the_token_to_the_app(plugin, owner_env):
    opener = Opener()
    assert plugin.record_vote(TOKEN, opener=opener) == ("recorded", "Yes")
    request, timeout = opener.requests[0]
    assert request.full_url == "https://agents.edgecity.live/api/referenda/vote-token"
    assert request.get_method() == "POST" and timeout == 10.0
    assert json.loads(request.data) == {"token": TOKEN, "tenantId": TENANT}


@pytest.mark.parametrize("status,body,outcome", [
    (200, b'{"ok":true}', "recorded"),
    (200, b'{"ok":false,"state":"invalid"}', "bad_response"),
    (200, b"not json", "bad_response"),
    (410, b'{"ok":false,"state":"expired"}', "expired"),
    (404, b'{"ok":false,"state":"invalid"}', "invalid"),
    (400, b"", "invalid"),
    (409, b'{"ok":false,"state":"expired"}', "expired"),
    (429, b"", "rate_limited"),
    (410, b'{"ok":false,"state":"expired","code":"voting_closed"}', "expired"),
    (404, b'{"ok":false,"state":"invalid","code":"vote_link_invalid"}', "invalid"),
    (403, b'{"ok":false,"state":"invalid","code":"browser_refused"}', "invalid"),
    (429, b'{"ok":false,"state":"busy"}', "rate_limited"),
    (503, b'{"ok":false,"state":"error","code":"vote_links_unconfigured"}', "http_error"),
    (500, b"", "http_error"),
    (302, b"", "http_error"),
])
def test_record_vote_maps_the_response(plugin, status, body, outcome):
    assert plugin.record_vote(TOKEN, opener=Opener(status, body))[0] == outcome


@pytest.mark.parametrize("error,outcome", [
    (TimeoutError("timed out"), "timeout"),
    (urllib.error.URLError(TimeoutError("timed out")), "timeout"),
    (urllib.error.URLError("refused"), "network"),
    (OSError("reset"), "network"),
])
def test_record_vote_network_failures(plugin, error, outcome):
    assert plugin.record_vote(TOKEN, opener=Opener(raises=error)) == (outcome, None)


def test_redirects_are_not_followed(plugin):
    assert plugin._NoRedirect().redirect_request(None, None, 302, "x", {}, "https://evil.example/") is None
    # The opener the plugin really uses carries that handler (OV-358 N2).
    assert any(isinstance(h, plugin._NoRedirect) for h in plugin._OPENER.handlers)
    assert not any(type(h) is urllib.request.HTTPRedirectHandler for h in plugin._OPENER.handlers)


@pytest.mark.parametrize("value,origin", [
    ("", "https://agents.edgecity.live"),
    ("https://staging.edgecity.live", "https://staging.edgecity.live"),
    ("https://staging.edgecity.live/", "https://staging.edgecity.live"),
    ("http://agents.edgecity.live", "https://agents.edgecity.live"),
    ("https://evil.example", "https://agents.edgecity.live"),
    ("https://edgecity.live.evil.example", "https://agents.edgecity.live"),
    ("https://user:pw@agents.edgecity.live", "https://agents.edgecity.live"),
    ("https://agents.edgecity.live/x?y=1", "https://agents.edgecity.live"),
])
def test_app_origin_is_pinned_to_edgecity_https(plugin, monkeypatch, value, origin):
    monkeypatch.setenv("AV_APP_ORIGIN", value)
    assert plugin.app_origin() == origin


# --------------------------------------------------------------------------- real PTB (skips without it)

def test_ptb_dispatch_order_and_keyboard(plugin, owner_env):
    telegram = pytest.importorskip("telegram")
    from telegram.ext import CallbackQueryHandler

    ours = CallbackQueryHandler(lambda u, c: None, pattern=plugin.HANDLER_PATTERN)
    core = CallbackQueryHandler(lambda u, c: None)  # Hermes's unscoped catch-all

    def first_match(data):
        upd = telegram.Update(1, callback_query=telegram.CallbackQuery(
            "1", telegram.User(int(OWNER), "R", False), "ci", data=data))
        for h in (ours, core):  # plugin handlers are wired before core (adapter.py:3120-3121)
            if h.check_update(upd):
                return h
        return None

    assert first_match(f"avv:0:{TOKEN}") is ours
    for data in CORE_CALLBACKS:
        assert first_match(data) is core

    made = []
    rows = [[telegram.InlineKeyboardButton("Yes", callback_data=f"avv:0:{TOKEN}")],
            [telegram.InlineKeyboardButton("No", callback_data=f"avv:1:{TOKEN_B}")],
            [telegram.InlineKeyboardButton("Vote on the web", url="https://agents.edgecity.live/referenda/r1")]]
    marked = plugin.mark_keyboard(tuple(tuple(r) for r in rows), f"avv:0:{TOKEN}",
                                  lambda t, d: made.append(t) or telegram.InlineKeyboardButton(t, callback_data=d))
    markup = telegram.InlineKeyboardMarkup(marked)
    assert [r[0].text for r in markup.inline_keyboard] == ["✅ Yes", "No", "Vote on the web"]
    assert markup.inline_keyboard[2][0].url == "https://agents.edgecity.live/referenda/r1"
    assert made == ["✅ Yes"]


def test_ptb_a_waiting_tap_never_blocks_the_bot(plugin, owner_env, monkeypatch):
    """OV-358 S1, through real python-telegram-bot 22.8 dispatch: Hermes builds its Application with
    the default update processor (one update at a time) and wires plugin handlers before core. While a
    vote tap waits for the app, the resident's next message and an exec-approval tap are processed, and
    a second tap on the same card is answered "Still recording" without a second request."""
    telegram = pytest.importorskip("telegram")
    from telegram.ext import ApplicationBuilder, CallbackQueryHandler, MessageHandler, filters

    gate = threading.Event()
    started = threading.Event()
    posted = []

    def slow_record(token, timeout=None):
        posted.append(token)
        started.set()
        gate.wait(5)
        return ("recorded", "Yes")

    monkeypatch.setattr(plugin, "record_vote", slow_record)
    events = []

    async def fake_answer(self, text=None, **_):
        events.append(("answer", self.id, text))

    async def fake_edit(self, reply_markup=None, **_):
        events.append(("edit", self.id))

    monkeypatch.setattr(telegram.CallbackQuery, "answer", fake_answer)
    monkeypatch.setattr(telegram.CallbackQuery, "edit_message_reply_markup", fake_edit)

    async def main():
        app = ApplicationBuilder().token("123:abc").build()
        assert app.update_processor.max_concurrent_updates == 1  # Hermes never sets concurrent_updates
        plugin._wire_telegram(app, None)  # plugin factories run before core registers (adapter.py:3238-3239)

        async def core_callback(update, context):
            events.append(("core", update.callback_query.data))

        async def text(update, context):
            events.append(("text", update.message.text))

        app.add_handler(MessageHandler(filters.TEXT, text))
        app.add_handler(CallbackQueryHandler(core_callback))  # Hermes's unscoped catch-all
        app._initialized = True
        app.bot._bot_user = telegram.User(42, "bot", True)
        app.bot._initialized = True
        await app.update_processor.initialize()

        user = telegram.User(int(OWNER), "R", False)
        chat = telegram.Chat(int(OWNER), "private")
        keyboard = telegram.InlineKeyboardMarkup(
            [[telegram.InlineKeyboardButton("Yes", callback_data=f"avv:0:{TOKEN}")],
             [telegram.InlineKeyboardButton("No", callback_data=f"avv:1:{TOKEN_B}")]])

        def tap(qid, data, message_id=5):
            message = telegram.Message(message_id, None, chat, reply_markup=keyboard)
            query = telegram.CallbackQuery(qid, user, "ci", data=data, message=message)
            query.set_bot(app.bot)
            return telegram.Update(int(qid), callback_query=query)

        async def dispatch(update):
            # Bounded: a blocking handler would hold this until the gate opens (the S1 defect).
            await asyncio.wait_for(app.update_processor.process_update(update, app.process_update(update)), 2)

        await dispatch(tap("1", f"avv:0:{TOKEN}"))
        assert await asyncio.to_thread(started.wait, 2)
        message = telegram.Message(6, None, chat, from_user=user, text="hello")
        message.set_bot(app.bot)
        await dispatch(telegram.Update(2, message=message))
        await dispatch(tap("3", "ea:once:1", message_id=7))
        await dispatch(tap("4", f"avv:0:{TOKEN}"))
        await asyncio.sleep(0.05)
        while_waiting = list(events)
        gate.set()
        for _ in range(200):
            if ("answer", "1", "Recorded: Yes") in events:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        return while_waiting

    try:
        while_waiting = run(main())
    finally:
        gate.set()
    assert ("text", "hello") in while_waiting
    assert ("core", "ea:once:1") in while_waiting
    assert ("answer", "4", "Still recording your vote...") in while_waiting
    assert not any(e[:2] == ("answer", "1") for e in while_waiting)
    assert ("answer", "1", "Recorded: Yes") in events and ("edit", "1") in events
    assert posted == [TOKEN]
