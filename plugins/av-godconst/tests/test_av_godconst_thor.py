"""av-godconst, third mode: the THOR daily nudge card (data's ODIN-THOR-NUDGES design section 5; product copy
THOR-NUDGE-CARD-COPY-2026-10-29).

Fakes only: the bot, the buttons, the tap and the control plane. Every call goes through the real client
(`thor_cp_call`) into a fake opener standing in for data's two routes (`GET /tenants/:id/thor/today`,
`POST /tenants/:id/thor/:item_key/answer`), which are not merged yet. Every person, title and draft is fictional.
"""

from __future__ import annotations

import asyncio
import email.message
import io
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
from datetime import datetime, timezone

import pytest

OWNER = 4242
TENANT = "0190a5b2-aaaa-4222-8333-444455556666"
EOS = "eos_box_key_marker"
THOR_KEY = "thor_custody_key_marker"
BALLOT_KEY = "ballot_key_marker"
DAY = datetime(2026, 10, 30, 5, 0, tzinfo=timezone.utc).timestamp()  # 10:30 IST, UTC day 2026-10-30
LATER_SAME_DAY = datetime(2026, 10, 30, 15, 0, tzinfo=timezone.utc).timestamp()  # 20:30 IST
NEXT_DAY = datetime(2026, 10, 31, 5, 0, tzinfo=timezone.utc).timestamp()
NIGHT = datetime(2026, 10, 30, 18, 0, tzinfo=timezone.utc).timestamp()  # 23:30 IST
FUTURE = "2099-01-01T00:00:00Z"
PAST = "2026-10-30T04:00:00Z"  # an hour before DAY
READ = f"/tenants/{TENANT}/thor/today"

TITLE = "Coffee with the robotics table"
DRAFT = "Asha's table is running a 20-minute demo at 4pm by the god tree; they asked for people who build hardware."
EVIDENCE = "You listed robotics and hardware as interests."
KEY1 = "a" * 64
KEY2 = "b" * 64


def run(coro):
    return asyncio.run(coro)


def item(key=KEY1, title=TITLE, draft=DRAFT, channel="room", expires=FUTURE, show=None, evidence=None, **extra):
    body = {"item_key": key, "title": title, "channel": channel, "draft": draft, "rank": 1, "expires_at": expires}
    if show is not None:
        body["show_evidence"] = show
    if evidence is not None:
        body["evidence"] = evidence
    body.update(extra)
    return body


class Button:
    def __init__(self, text, callback_data):
        self.text, self.callback_data = text, callback_data


class Markup:
    def __init__(self, rows):
        self.inline_keyboard = rows


def make_button(text, data):
    return Button(text, data)


def make_markup(rows):
    return Markup(rows)


class Msg:
    def __init__(self, message_id, chat_id, text, markup, bot):
        self.message_id, self.text, self.reply_markup, self._bot = message_id, text, markup, bot
        self.chat = type("Chat", (), {"id": chat_id, "type": "private"})()

    def get_bot(self):
        return self._bot


class Bot:
    def __init__(self):
        self.sent, self.fail = [], 0
        self._next = 100

    async def send_message(self, chat_id, text, parse_mode=None, reply_markup=None, disable_web_page_preview=None):
        if self.fail:
            self.fail -= 1
            raise RuntimeError("Forbidden: bot was blocked by the user")
        self._next += 1
        msg = Msg(self._next, chat_id, text, reply_markup, self)
        self.sent.append(msg)
        return msg

    def cards(self):
        return [m for m in self.sent if m.reply_markup and m.reply_markup.inline_keyboard[0][0].callback_data.startswith("avt:")]

    def lines(self):
        return [m.text for m in self.sent if m.reply_markup is None]


class _Response:
    def __init__(self, status, raw):
        self.status, self._raw = status, io.BytesIO(raw)

    def read(self, n=-1):
        return self._raw.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Server:
    """Data's two THOR routes, as the contract states them; records (method, path, auth, body)."""

    def __init__(self, plugin, items=None, no_key=False):
        self.P = plugin
        self.items = [item()] if items is None else items
        self.calls = []
        self.read_refuse = None
        self.answer_refuse = None
        self.network_down = 0
        with open(os.path.join(os.environ["HERMES_HOME"], ".env"), "w", encoding="utf-8") as handle:
            handle.write(f"CONTROL_PLANE_URL=http://127.0.0.1:9\nEDGEOS_API_KEY={EOS}\nAV_GODCONST_BALLOT_KEY={BALLOT_KEY}\n"
                         + ("" if no_key else f"AV_THOR_KEY={THOR_KEY}\n"))
        plugin._OPENER = self

    def __call__(self, method, path, body=None, home=None):
        return self.P.thor_cp_call(method, path, body, home)

    def reads(self):
        return [c for c in self.calls if c[0] == "GET"]

    def answers(self):
        return [c for c in self.calls if c[0] == "POST"]

    def open(self, request, timeout=None):
        method, path = request.get_method(), urllib.parse.urlsplit(request.full_url).path
        body = json.loads(request.data) if request.data else None
        self.calls.append((method, path, request.get_header("Authorization"), body))
        if self.network_down:
            self.network_down -= 1
            raise urllib.error.URLError("connection refused")
        status, payload = self.answer(method, path, body)
        raw = json.dumps(payload).encode()
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, "refused", email.message.Message(), io.BytesIO(raw))
        return _Response(status, raw)

    def answer(self, method, path, body):
        if method == "GET" and path == READ:
            if self.read_refuse:
                return self.read_refuse, {"error": "not_found" if self.read_refuse == 404 else "unavailable"}
            served, self.items = self.items[:1] if len(self.items) == 1 else self.items, []
            return 200, {"items": served}
        prefix, suffix = f"/tenants/{TENANT}/thor/", "/answer"
        if method == "POST" and path.startswith(prefix) and path.endswith(suffix):
            if set(body) != {"answer"} or body["answer"] not in ("do_it", "not_now", "not_for_me"):
                return 400, {"error": "body_invalid"}
            if self.answer_refuse:
                return self.answer_refuse
            return 200, {"state": "recorded"}
        return 404, {"error": "not_found"}


class Query:
    def __init__(self, data, message, user=OWNER, chat_type="private"):
        self.data, self.message = data, message
        self.from_user = type("U", (), {"id": user})()
        if chat_type != "private":
            message.chat.type = chat_type
        self.answers, self.edited = [], []

    async def answer(self, text=None):
        self.answers.append(text)

    async def edit_message_reply_markup(self, reply_markup=None):
        self.edited.append(reply_markup)
        self.message.reply_markup = reply_markup


@pytest.fixture
def thor(home, monkeypatch):
    # No box flag: the box switch is AV_THOR_KEY alone (Server writes it to the .env); THOR_NUDGES_ENABLED is the cp's.
    monkeypatch.delenv("THOR_NUDGES_ENABLED", raising=False)
    monkeypatch.setenv("AV_GODCONST_BALLOT", "0")
    return home


def pass_(P, bot, server, now=DAY):
    return run(P.thor_pass_once(bot, None, make_button, make_markup, now=now, reader=server))


def tap(P, server, msg, index=0, *, user=OWNER, data=None, chat_type="private"):
    q = Query(data or msg.reply_markup.inline_keyboard[0][index].callback_data, msg, user=user, chat_type=chat_type)
    handler = P.make_thor_handler(None, make_button=make_button, make_markup=make_markup, caller=server, clock=lambda: DAY)
    run(handler(type("Update", (), {"callback_query": q})()))
    return q


def ledger(home):
    with open(os.path.join(home, "av-godconst", "thor.json"), encoding="utf-8") as handle:
        return json.load(handle)


def assert_nothing_private_on_disk(home):
    path = os.path.join(home, "av-godconst", "thor.json")
    raw = open(path, encoding="utf-8").read()
    for text in (TITLE, DRAFT, EVIDENCE, "Asha", "Ravi", EOS, BALLOT_KEY, THOR_KEY, "robotics"):
        assert text not in raw
    assert oct(os.stat(path).st_mode & 0o777) == "0o600"
    for card in json.loads(raw)["cards"]:
        assert set(card) == {"nonce", "item_key", "intro", "role", "day", "status", "message_id", "chat", "sent_at",
                             "send_failures", "answer", "answered_at"}


# --------------------------------------------------------------------------- the copy, verbatim


def test_the_copy_strings_are_the_copy_files_verbatim(plugin):
    T = plugin.T
    assert T.THOR_NUDGE_SIGNOFF == "From ODIN, one a day at most."
    assert T.THOR_NUDGE_WHY == "Why you: "
    assert (T.THOR_NUDGE_DO, T.THOR_NUDGE_LATER, T.THOR_NUDGE_NEVER) == ("Do it", "Not now", "Not for me")
    assert T.THOR_NUDGE_DONE == "Done: {title}."
    assert T.THOR_NUDGE_NOTED == "Noted."
    assert T.THOR_NUDGE_INTRO_ASKED == "Asked. ODIN will check with {b} too."
    assert T.THOR_NUDGE_INTRO_MIRROR == "{a} would like an intro."
    assert T.THOR_NUDGE_INTRO_MATCH == "It's a match: {a} and {b} both said yes."
    assert T.THOR_NUDGE_LATER_OK == "OK. ODIN may bring this back another day."
    assert T.THOR_NUDGE_NEVER_OK == "OK. You won't see this one again."


def test_the_card_is_the_copy_files_shape(plugin, thor):
    bot, server = Bot(), Server(plugin, [item(show=True, evidence=EVIDENCE)])
    pass_(plugin, bot, server)
    (card,) = bot.cards()
    assert card.text == (
        "Coffee with the robotics table\n\n"
        "Asha's table is running a 20-minute demo at 4pm by the god tree; they asked for people who build hardware.\n\n"
        "Why you: You listed robotics and hardware as interests.\n\n"
        "From ODIN, one a day at most. Do it · Not now · Not for me")
    assert [b.text for b in card.reply_markup.inline_keyboard[0]] == ["Do it", "Not now", "Not for me"]
    assert len(card.reply_markup.inline_keyboard) == 1
    assert all(len(b.callback_data.encode()) <= 64 for b in card.reply_markup.inline_keyboard[0])


@pytest.mark.parametrize("show,evidence", [(None, None), (False, None), (False, EVIDENCE), (None, EVIDENCE), ("true", EVIDENCE),
                                           (True, None), (True, "   ")])
def test_no_why_you_line_unless_show_evidence_is_true_and_the_text_is_there(plugin, thor, show, evidence):
    bot, server = Bot(), Server(plugin, [item(show=show, evidence=evidence)])
    pass_(plugin, bot, server)
    (card,) = bot.cards()
    assert "Why you:" not in card.text and EVIDENCE not in card.text
    assert card.text == f"{plugin.html.escape(TITLE, quote=False)}\n\n{plugin.html.escape(DRAFT, quote=False)}\n\n" \
                        "From ODIN, one a day at most. Do it · Not now · Not for me"


def test_html_in_a_field_is_escaped(plugin, thor):
    bot, server = Bot(), Server(plugin, [item(title="<b>Tea</b> & talk", draft="Bring <code>?")])
    pass_(plugin, bot, server)
    assert bot.cards()[0].text.startswith("&lt;b&gt;Tea&lt;/b&gt; &amp; talk\n\nBring &lt;code&gt;?")


def test_a_long_card_is_trimmed_at_a_sentence_and_fits_telegram(plugin, thor):
    long_draft = " ".join(f"Sentence number {i} is here." for i in range(500))
    bot, server = Bot(), Server(plugin, [item(draft=long_draft, show=True, evidence="Because. " * 400)])
    pass_(plugin, bot, server)
    text = bot.cards()[0].text
    assert len(text) <= 4096
    draft_part = text.split("\n\n")[1]
    assert draft_part.endswith("is here.")
    assert text.endswith("From ODIN, one a day at most. Do it · Not now · Not for me")


# --------------------------------------------------------------------------- the switch, the day, the window


def test_the_mode_is_on_with_only_the_key(plugin, thor):
    bot, server = Bot(), Server(plugin)
    dotenv = open(os.path.join(thor, ".env"), encoding="utf-8").read()
    assert "THOR_NUDGES_ENABLED" not in os.environ and "THOR_NUDGES_ENABLED" not in dotenv and "AV_THOR_KEY=" in dotenv
    pass_(plugin, bot, server)
    assert len(bot.cards()) == 1 and len(server.reads()) == 1


@pytest.mark.parametrize("value", ["0", "false", "off", ""])
def test_the_box_never_reads_the_cps_flag(plugin, thor, monkeypatch, value):
    monkeypatch.setenv("THOR_NUDGES_ENABLED", value)  # the cp's flag: the cp answers empty while it is off
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    assert len(bot.cards()) == 1


def test_the_other_on_conditions_still_hold(plugin, thor, monkeypatch):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server, now=NIGHT)  # outside 08:00-21:30 IST
    monkeypatch.setenv("CONTROL_PLANE_URL", "https://evil.example.com")  # not a pinned host
    pass_(plugin, bot, server)
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("AV_TENANT_ID", "not-a-uuid")
    pass_(plugin, bot, server)
    assert server.calls == [] and bot.sent == []


def test_one_card_max_per_utc_day(plugin, thor):
    bot, server = Bot(), Server(plugin, [item()])
    pass_(plugin, bot, server)
    server.items = [item(key=KEY2, title="Another one")]
    for now in (DAY + 60, DAY + 3600, LATER_SAME_DAY):
        pass_(plugin, bot, server, now=now)
    assert len(bot.cards()) == 1 and len(server.reads()) == 1
    pass_(plugin, bot, server, now=NEXT_DAY)
    assert len(bot.cards()) == 2 and len(server.reads()) == 2
    assert bot.cards()[1].text.startswith("Another one")
    assert_nothing_private_on_disk(thor)


def test_an_empty_day_reads_once(plugin, thor):
    bot, server = Bot(), Server(plugin, [])
    pass_(plugin, bot, server)
    server.items = [item()]
    pass_(plugin, bot, server, now=LATER_SAME_DAY)
    assert bot.sent == [] and len(server.reads()) == 1


def test_more_than_one_item_still_one_card(plugin, thor):
    bot, server = Bot(), Server(plugin, [item(key=KEY1, title="First"), item(key=KEY2, title="Second")])
    pass_(plugin, bot, server)
    assert [c.text.split("\n")[0] for c in bot.cards()] == ["First"]


def test_the_item_envelope_may_be_a_single_item(plugin, thor):
    T = plugin.T
    got, code = T.today_item({"item": item()}, DAY)
    assert code == "served" and got["item_key"] == KEY1
    assert T.today_item({"item": None}, DAY) == (None, "empty")
    assert T.today_item({"other": []}, DAY) == (None, "bad_response")
    assert T.today_item([], DAY) == (None, "bad_response")


def test_no_read_at_night(plugin, thor):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server, now=NIGHT)
    assert server.calls == [] and bot.sent == []


def test_no_home_chat_no_read(plugin, thor, monkeypatch):
    monkeypatch.delenv("TELEGRAM_HOME_CHANNEL", raising=False)
    bot, server = Bot(), Server(plugin)
    assert pass_(plugin, bot, server) == {"no_home_chat": 1}
    assert server.calls == []


# --------------------------------------------------------------------------- expiry


def test_an_expired_item_is_never_rendered(plugin, thor):
    bot, server = Bot(), Server(plugin, [item(expires=PAST)])
    assert pass_(plugin, bot, server) == {"read_expired": 1}
    assert bot.sent == []


def test_an_expired_item_is_skipped_for_a_live_one(plugin, thor):
    bot, server = Bot(), Server(plugin, [item(key=KEY1, title="Old", expires=PAST), item(key=KEY2, title="Live")])
    pass_(plugin, bot, server)
    assert [c.text.split("\n")[0] for c in bot.cards()] == ["Live"]


@pytest.mark.parametrize("expires", [None, "", "tomorrow", "2099-01-01T00:00:00"])
def test_an_item_without_a_usable_expiry_is_never_rendered(plugin, thor, expires):
    bot, server = Bot(), Server(plugin, [item(expires=expires)])
    assert pass_(plugin, bot, server) == {"read_invalid": 1}
    assert bot.sent == []


def test_a_card_that_expires_before_its_retried_send_is_dropped(plugin, thor):
    soon = datetime.fromtimestamp(DAY + 300, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    bot, server = Bot(), Server(plugin, [item(expires=soon)])
    bot.fail = 1
    assert pass_(plugin, bot, server) == {"served": 1, "send_failed": 1}
    assert pass_(plugin, bot, server, now=DAY + 600) == {"expired_unsent": 1}
    assert bot.sent == [] and ledger(thor)["cards"][0]["status"] == "expired"


@pytest.mark.parametrize("bad", [
    {"title": ""}, {"title": None}, {"draft": ""}, {"draft": 5}, {"item_key": "x/y"}, {"item_key": ""}, {"channel": "x" * 65},
])
def test_an_unusable_item_is_never_rendered(plugin, thor, bad):
    body = item()
    body.update(bad)
    bot, server = Bot(), Server(plugin, [body])
    pass_(plugin, bot, server)
    assert bot.sent == []


# --------------------------------------------------------------------------- the three answers


@pytest.mark.parametrize("index,value,line", [
    (0, "do_it", "Noted."),
    (1, "not_now", "OK. ODIN may bring this back another day."),
    (2, "not_for_me", "OK. You won't see this one again."),
])
def test_each_tap_posts_its_value_once_and_shows_the_copy_line(plugin, thor, index, value, line):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    card = bot.cards()[0]
    q = tap(plugin, server, card, index)
    assert server.answers() == [("POST", f"/tenants/{TENANT}/thor/{KEY1}/answer", f"Bearer {THOR_KEY}", {"answer": value})]
    assert q.answers == [line]
    assert bot.lines()[-1] == plugin.html.escape(line, quote=False)
    (row,) = card.reply_markup.inline_keyboard
    assert [b.text for b in row] == ["✅ " + ["Do it", "Not now", "Not for me"][index]]
    # A second tap (the marked button, or a stale one) records nothing more.
    again = tap(plugin, server, card, 0)
    assert again.answers == ["Already noted."] and len(server.answers()) == 1
    assert ledger(thor)["cards"][0]["answer"] == value
    assert_nothing_private_on_disk(thor)


def test_a_failed_answer_keeps_the_card_and_a_retap_posts_again(plugin, thor):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    card = bot.cards()[0]
    server.network_down = 1
    assert tap(plugin, server, card, 1).answers == ["Could not save that. Tap again in a moment."]
    assert len(card.reply_markup.inline_keyboard[0]) == 3 and ledger(thor)["cards"][0]["answer"] is None
    assert tap(plugin, server, card, 1).answers == ["OK. ODIN may bring this back another day."]
    assert len(server.answers()) == 2


@pytest.mark.parametrize("refusal,text", [
    ((410, {"error": "thor_item_expired"}), "This card has closed."),
    ((410, {"error": "thor_already_answered"}), "This card has closed."),
    ((410, {"error": "thor_nudges_off"}), "This card has closed."),
    ((404, {"error": "thor_unknown_item"}), "This card has closed."),
    ((403, {"error": "thor_not_yours"}), "This card has closed."),
    ((401, {"error": "unauthorized"}), "Could not save that. Tap again in a moment."),
    ((400, {"error": "body_invalid"}), "Could not save that. Tap again in a moment."),
    ((503, {"error": "unavailable"}), "Could not save that. Tap again in a moment."),
])
def test_a_refused_answer(plugin, thor, refusal, text):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    server.answer_refuse = refusal
    assert tap(plugin, server, bot.cards()[0], 2).answers == [text]
    assert ledger(thor)["cards"][0]["answer"] is None


def test_only_the_own_resident_in_their_own_dm(plugin, thor):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    card = bot.cards()[0]
    assert tap(plugin, server, card, 0, user=999).answers == ["This card is not yours"]
    assert tap(plugin, server, card, 0, chat_type="group").answers == ["This card is not yours"]
    assert server.answers() == []


def test_a_forged_or_old_button_records_nothing(plugin, thor):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    card = bot.cards()[0]
    assert tap(plugin, server, card, data="avt:x:AAAAAAAA").answers == ["This button is not valid."]
    assert tap(plugin, server, card, data="avt:d:ZZZZZZZZ").answers == ["This card is no longer valid."]
    other = Msg(999, OWNER, "x", None, bot)
    assert tap(plugin, server, other, data=card.reply_markup.inline_keyboard[0][0].callback_data).answers == ["This card is no longer valid."]
    assert server.answers() == []


def test_yesterdays_unanswered_card_still_takes_its_answer(plugin, thor):
    bot, server = Bot(), Server(plugin, [item(key=KEY1)])
    pass_(plugin, bot, server)
    server.items = [item(key=KEY2, title="Second day")]
    pass_(plugin, bot, server, now=NEXT_DAY)
    first, second = bot.cards()
    tap(plugin, server, first, 1)
    tap(plugin, server, second, 2)
    assert [c[1] for c in server.answers()] == [f"/tenants/{TENANT}/thor/{KEY1}/answer", f"/tenants/{TENANT}/thor/{KEY2}/answer"]


# --------------------------------------------------------------------------- intros


def test_a_card_on_a_cards_intro_says_asked_with_the_other_first_name(plugin, thor):
    intro = item(channel="room", intro=True, role="a", other_first_name="Ravi", title="An intro for your hardware idea",
                 draft="Someone building sensor rigs could help with your prototype.", recipients=["Ravi Example"])
    bot, server = Bot(), Server(plugin, [intro])
    pass_(plugin, bot, server)
    card = bot.cards()[0]
    assert "Ravi" not in card.text  # the name is never rendered on the card, only in A's follow-up line
    assert tap(plugin, server, card, 0).answers == ["Asked. ODIN will check with Ravi too."]
    assert bot.lines()[-1] == "Asked. ODIN will check with Ravi too."
    stored = ledger(thor)["cards"][0]
    assert stored["intro"] is True and stored["role"] == "a"
    assert [c[0] for c in server.calls] == ["GET", "POST"]  # nobody else is contacted
    assert_nothing_private_on_disk(thor)


A_PRIVATE = "Asha mentioned a private reason that only her own card may show."


@pytest.mark.parametrize("fields", [
    {"title": None, "draft": None, "show_evidence": False},           # cp#493's role-b item, as data sends it
    {"title": None, "draft": None, "channel": None},                  # a null channel too
    {"title": "Coffee about sensor rigs", "draft": A_PRIVATE, "show_evidence": True, "evidence": "Asha's evidence line."},
])
def test_bs_mirror_card_is_only_the_mirror_line(plugin, thor, fields):
    mirror = item(intro=True, role="b", other_first_name="Asha")
    mirror.update(fields)
    bot, server = Bot(), Server(plugin, [mirror])
    pass_(plugin, bot, server)
    (card,) = bot.cards()
    assert card.text == "Asha would like an intro."
    assert A_PRIVATE not in card.text and "evidence" not in card.text and "Coffee" not in card.text
    assert [b.text for b in card.reply_markup.inline_keyboard[0]] == ["Do it", "Not now", "Not for me"]
    assert tap(plugin, server, card, 0).answers == ["Noted."]
    assert not any(line.startswith("Asked.") for line in bot.lines())
    assert server.answers()[0][3] == {"answer": "do_it"}


@pytest.mark.parametrize("name", [None, "", "  "])
def test_a_role_b_card_with_no_first_name_is_skipped(plugin, thor, caplog, name):
    caplog.set_level(logging.DEBUG)
    extra = {} if name is None else {"other_first_name": name}
    bot, server = Bot(), Server(plugin, [item(intro=True, role="b", draft=A_PRIVATE, **extra)])
    assert pass_(plugin, bot, server) == {"mirror_no_name": 1}
    pass_(plugin, bot, server, now=LATER_SAME_DAY)
    assert bot.sent == [] and len(server.reads()) == 1
    lines = "\n".join(r.getMessage() for r in caplog.records)
    assert "outcome=thor_mirror_no_name" in lines and A_PRIVATE not in lines and TITLE not in lines


@pytest.mark.parametrize("channel", ["Telegram", "in person", "1:1 intro", "room", "x" * 64, "Café ☕"])
def test_any_non_empty_channel_up_to_64_characters_is_accepted(plugin, thor, channel):
    bot, server = Bot(), Server(plugin, [item(channel=channel)])
    pass_(plugin, bot, server)
    (card,) = bot.cards()
    assert channel not in card.text or channel == "room" and "room" not in card.text  # never rendered


@pytest.mark.parametrize("channel", ["", "   ", "x" * 65, None, 7])
def test_an_empty_long_or_non_string_channel_is_refused(plugin, thor, channel):
    bot, server = Bot(), Server(plugin, [item(channel=channel)])
    assert pass_(plugin, bot, server) == {"read_invalid": 1}


@pytest.mark.parametrize("fields", [
    {},                                                    # non-intro: both fields missing
    {"intro": True, "role": "a"},                          # B will not be asked: no name
    {"intro": True, "role": "a", "other_first_name": " "},
    {"intro": True, "other_first_name": "Ravi"},           # no role: never guessed to be A
    {"intro": "true", "role": "a", "other_first_name": "Ravi"},
    {"intro": False, "role": "a", "other_first_name": "Ravi"},
    {"channel": "intro", "other_first_name": "Ravi"},      # the channel text is not the intro marker
])
def test_do_it_is_plain_noted_without_a_cards_intro_and_name(plugin, thor, fields):
    body = item()
    body.update(fields)
    bot, server = Bot(), Server(plugin, [body])
    pass_(plugin, bot, server)
    card = bot.cards()[0]
    assert "Ravi" not in card.text
    assert tap(plugin, server, card, 0).answers == ["Noted."]


def test_an_intro_card_shows_a_name_only_when_it_is_in_timours_draft(plugin, thor):
    intro = item(intro=True, role="a", title="Meet a hardware builder", draft="Asha builds sensor rigs and asked to meet builders.")
    bot, server = Bot(), Server(plugin, [intro])
    pass_(plugin, bot, server)
    assert "Asha builds sensor rigs" in bot.cards()[0].text


def test_the_intro_asked_line_needs_role_a_and_a_given_first_name(plugin):
    T = plugin.T
    assert T.follow_up("d", True) == "Noted."
    assert T.follow_up("d", True, "  ", "a") == "Noted."
    assert T.follow_up("d", True, "Asha", "a") == "Asked. ODIN will check with Asha too."
    assert T.follow_up("d", True, "Asha", "b") == "Noted."
    assert T.follow_up("d", True, "Asha") == "Noted."
    assert T.follow_up("d", False, "Asha", "a") == "Noted."
    assert T.follow_up("l", True, "Asha", "a") == "OK. ODIN may bring this back another day."


# --------------------------------------------------------------------------- 401 / 403 while the key rolls out


@pytest.mark.parametrize("status,code", [(401, "unauthorized"), (403, "unauthorized"), (404, "route_dark")])
def test_an_unauthorized_or_dark_read_is_no_card_and_not_one_of_the_days_reads(plugin, thor, caplog, status, code):
    caplog.set_level(logging.DEBUG)
    bot, server = Bot(), Server(plugin)
    server.read_refuse = status
    read_at = []
    times = [DAY + i * 60 for i in range(60)] + [DAY + 3600 + i * plugin.THOR_RETRY_S for i in range(1, 2 * plugin.THOR_READS_PER_DAY)]
    for now in times:
        before = len(server.reads())
        assert pass_(plugin, bot, server, now=now) in ({}, {code: 1})
        if len(server.reads()) > before:
            read_at.append(now)
    assert bot.sent == []  # no resident-facing text
    assert len(read_at) > plugin.THOR_READS_PER_DAY  # never spent the day's reads
    assert all(b - a >= plugin.THOR_RETRY_S for a, b in zip(read_at, read_at[1:]))
    lines = [r.getMessage() for r in caplog.records if "thor" in r.getMessage()]
    assert lines == [f"av-godconst: tenant=0190a5b2 outcome=thor_{code}"]  # once a UTC day, not per attempt
    assert ledger(thor)["reads"] == 0 and ledger(thor)["done"] is False
    # The key lands later that day: the card arrives that same day.
    server.read_refuse = None
    pass_(plugin, bot, server, now=times[-1] + plugin.THOR_RETRY_S)
    assert len(bot.cards()) == 1


# --------------------------------------------------------------------------- reads that fail


def test_a_network_failure_retries_after_the_backoff_and_reads_are_capped(plugin, thor):
    bot, server = Bot(), Server(plugin)
    server.network_down = 10
    assert pass_(plugin, bot, server) == {"read_retry_network": 1}
    pass_(plugin, bot, server, now=DAY + 60)
    assert len(server.reads()) == 1
    for i in range(1, 6):
        pass_(plugin, bot, server, now=DAY + i * plugin.THOR_RETRY_S + 1)
    assert len(server.reads()) == plugin.THOR_READS_PER_DAY and bot.sent == []


def test_a_refused_read_waits_for_the_next_day(plugin, thor):
    bot, server = Bot(), Server(plugin)
    server.read_refuse = 400
    assert pass_(plugin, bot, server) == {"read_refused_unavailable": 1}
    pass_(plugin, bot, server, now=LATER_SAME_DAY)
    assert len(server.reads()) == 1
    server.read_refuse = None
    pass_(plugin, bot, server, now=NEXT_DAY)
    assert len(bot.cards()) == 1


def test_a_5xx_read_retries(plugin, thor):
    bot, server = Bot(), Server(plugin)
    server.read_refuse = 503
    assert pass_(plugin, bot, server) == {"read_retry_unavailable": 1}
    server.read_refuse = None
    pass_(plugin, bot, server, now=DAY + plugin.THOR_RETRY_S + 1)
    assert len(bot.cards()) == 1


def test_a_failed_send_retries_from_memory_without_a_second_read(plugin, thor):
    bot, server = Bot(), Server(plugin)
    bot.fail = 2
    pass_(plugin, bot, server)
    pass_(plugin, bot, server, now=DAY + 60)
    assert bot.sent == []
    assert pass_(plugin, bot, server, now=DAY + 120) == {"card_sent": 1}
    assert len(bot.cards()) == 1 and len(server.reads()) == 1


def test_three_failed_sends_give_up_for_the_day(plugin, thor):
    bot, server = Bot(), Server(plugin)
    bot.fail = 3
    for i in range(4):
        pass_(plugin, bot, server, now=DAY + i * 60)
    assert bot.sent == [] and ledger(thor)["cards"][0]["status"] == "undeliverable" and len(server.reads()) == 1


def test_a_restart_between_read_and_send_loses_that_days_card_only(plugin, thor):
    bot, server = Bot(), Server(plugin)
    bot.fail = 1
    pass_(plugin, bot, server)
    plugin._THOR_PENDING.clear()  # what a restart forgets
    assert pass_(plugin, bot, server, now=DAY + 60) == {"send_lost": 1}
    pass_(plugin, bot, server, now=LATER_SAME_DAY)
    assert bot.sent == [] and len(server.reads()) == 1


# --------------------------------------------------------------------------- the wire, logs, privacy, fail-open


def test_the_wire_uses_the_box_credential_and_the_pinned_host(plugin, thor, monkeypatch):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    assert server.reads() == [("GET", READ, f"Bearer {THOR_KEY}", None)]
    monkeypatch.setenv("CONTROL_PLANE_URL", "https://evil.example.com")
    assert plugin.thor_cp_call("GET", plugin.THOR_READ_PATH).code == "not_configured"
    monkeypatch.setenv("CONTROL_PLANE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("AV_THOR_KEY", "")
    assert plugin.thor_cp_call("GET", plugin.THOR_READ_PATH).code == "not_configured"
    assert all(c[2] == f"Bearer {THOR_KEY}" and EOS not in str(c) for c in server.calls)


def test_both_routes_carry_the_custody_key_never_edgeos_api_key(plugin, thor, monkeypatch):
    monkeypatch.setenv("EDGEOS_API_KEY", EOS)  # present and agent-readable: never sent
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    tap(plugin, server, bot.cards()[0], 0)
    assert [(c[0], c[2]) for c in server.calls] == [("GET", f"Bearer {THOR_KEY}"), ("POST", f"Bearer {THOR_KEY}")]
    assert plugin.THOR_CREDENTIAL_ENV == "AV_THOR_KEY"


@pytest.mark.parametrize("blank", [False, True])
def test_no_custody_key_no_read_no_card_one_code_line(plugin, thor, monkeypatch, caplog, blank):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("EDGEOS_API_KEY", EOS)  # no fallback to it
    bot, server = Bot(), Server(plugin, no_key=True)
    if blank:
        monkeypatch.setenv("AV_THOR_KEY", "")
    for now in [DAY + i * 60 for i in range(60)] + [LATER_SAME_DAY]:
        assert pass_(plugin, bot, server, now=now) == {}
    lines = [r.getMessage() for r in caplog.records if "thor" in r.getMessage()]
    assert lines == ["av-godconst: tenant=0190a5b2 outcome=thor_no_key"]  # once a UTC day, not per pass
    for now in (NEXT_DAY, NEXT_DAY + 60, NIGHT + 86400):
        assert pass_(plugin, bot, server, now=now) == {}
    lines = [r.getMessage() for r in caplog.records if "thor" in r.getMessage()]
    assert lines == ["av-godconst: tenant=0190a5b2 outcome=thor_no_key"] * 2  # and once again the next UTC day
    assert server.calls == [] and bot.sent == []
    assert not os.path.exists(os.path.join(thor, "av-godconst", "thor.json"))


def test_a_tap_after_the_key_is_gone_posts_nothing(plugin, thor, monkeypatch):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    monkeypatch.setenv("AV_THOR_KEY", "")
    q = tap(plugin, server, bot.cards()[0], 1)
    assert q.answers == ["This card has closed."] and server.answers() == []


def test_the_thor_key_stays_in_custody(plugin):
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(plugin.__file__))))
    with open(os.path.join(root, "plugins", "av-approval", "custody_keys.json"), encoding="utf-8") as handle:
        names = json.load(handle)["names"]
    assert names["AV_THOR_KEY"]["decision"] == "strip"
    with open(os.path.join(root, "plugins", "av-approval", "_custody.py"), encoding="utf-8") as handle:
        assert '"AV_THOR_KEY"' in handle.read()


def test_logs_carry_codes_and_counts_only(plugin, thor, caplog):
    caplog.set_level(logging.DEBUG)
    bot, server = Bot(), Server(plugin, [item(intro=True, role="a", other_first_name="Ravi", show=True, evidence=EVIDENCE)])
    pass_(plugin, bot, server)
    card = bot.cards()[0]
    tap(plugin, server, card, 0, user=999)
    tap(plugin, server, card, 0)
    lines = "\n".join(r.getMessage() for r in caplog.records)
    assert "outcome=thor_served" in lines and "outcome=thor_card_sent" in lines and "outcome=thor_answered do_it=1" in lines
    for secret in (TITLE, DRAFT, EVIDENCE, "Asha", "Ravi", KEY1, EOS, THOR_KEY, "avt:", str(OWNER), "999", TENANT):
        assert secret not in lines


def test_nothing_is_injected(plugin):
    source = open(os.path.join(os.path.dirname(plugin.__file__), "_thor.py"), encoding="utf-8").read()
    assert "inject_message" not in source and "emit_event" not in source


def test_the_pass_and_the_tap_never_raise(plugin, thor, monkeypatch):
    bot, server = Bot(), Server(plugin)

    def boom(*a, **k):
        raise RuntimeError("x")

    assert run(plugin.thor_pass_once(bot, None, make_button, make_markup, now=DAY, reader=boom)) == {}
    pass_(plugin, bot, server, now=NEXT_DAY)
    card = bot.cards()[0]
    q = Query(card.reply_markup.inline_keyboard[0][0].callback_data, card)
    handler = plugin.make_thor_handler(None, make_button=make_button, make_markup=make_markup, caller=boom, clock=lambda: DAY)
    run(handler(type("Update", (), {"callback_query": q})()))
    assert q.answers == ["Could not save that. Tap again in a moment."]
    for name in ("load_thor_ledger", "home_chat_id"):
        with monkeypatch.context() as m:
            m.setattr(plugin, name, boom)
            run(plugin.thor_pass_once(bot, None, make_button, make_markup, now=NEXT_DAY + 60, reader=server))
            assert len(tap(plugin, server, card, 1).answers) == 1


def test_the_ballot_never_reads_the_thor_route_nor_thor_the_ballot_key(plugin, thor):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    tap(plugin, server, bot.cards()[0], 2)
    assert all(c[2] == f"Bearer {THOR_KEY}" and "/thor/" in c[1] for c in server.calls)
    assert not os.path.exists(os.path.join(thor, "av-godconst", "ballot.json"))


def test_the_in_flight_string_uses_the_ellipsis_character(plugin):
    assert plugin.T.IN_FLIGHT == "Still saving\u2026"


# --------------------------------------------------------------------------- review-b ov#561 N2, N3


def _read_only_ledger_dir(home):
    path = os.path.join(home, "av-godconst")
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o500)  # private, readable, not writable: every ledger save fails
    return path


@pytest.mark.parametrize("served", [True, False])
def test_an_unwritable_ledger_still_caps_the_days_reads(plugin, thor, served):
    bot, server = Bot(), Server(plugin)
    if not served:
        server.network_down = 1000
    path = _read_only_ledger_dir(thor)
    read_at = []
    times = [DAY + i * 60 for i in range(120)]  # two hours of passes, one a minute, and then the rest of the day
    times += [DAY + 7200 + i * plugin.THOR_RETRY_S for i in range(1, 12)]
    try:
        for now in times:
            before = len(server.reads())
            pass_(plugin, bot, server, now=now)
            if len(server.reads()) > before:
                read_at.append(now)
        assert not os.path.exists(os.path.join(path, "thor.json"))
    finally:
        os.chmod(path, 0o700)
    assert len(server.reads()) == (1 if served else plugin.THOR_READS_PER_DAY)
    # review-b DN1: the backoff holds in memory too, so failed reads stay THOR_RETRY_S apart, never a burst.
    assert all(b - a >= plugin.THOR_RETRY_S for a, b in zip(read_at, read_at[1:]))
    assert bot.cards() == []  # the write-ahead save failed: nothing is sent that the ledger could not record
    pass_(plugin, bot, server, now=NEXT_DAY)  # a new UTC day, the ledger writable again: one read, one card
    assert len(server.reads()) == (2 if served else plugin.THOR_READS_PER_DAY + 1)


def test_two_taps_at_once_on_one_card_post_exactly_once(plugin, thor):
    bot, server = Bot(), Server(plugin)
    pass_(plugin, bot, server)
    card = bot.cards()[0]
    entered, release = threading.Event(), threading.Event()

    def slow(method, path, body=None, home=None):
        entered.set()
        release.wait(5)
        return server(method, path, body, home)

    handler = plugin.make_thor_handler(None, make_button=make_button, make_markup=make_markup, caller=slow, clock=lambda: DAY)
    first = Query(card.reply_markup.inline_keyboard[0][0].callback_data, card)
    second = Query(card.reply_markup.inline_keyboard[0][2].callback_data, card)

    async def both():
        one = asyncio.ensure_future(handler(type("Update", (), {"callback_query": first})()))
        while not entered.is_set():
            await asyncio.sleep(0.01)
        await handler(type("Update", (), {"callback_query": second})())
        release.set()
        await one

    start = time.monotonic()
    run(both())
    assert time.monotonic() - start < 5
    assert second.answers == ["Still saving\u2026"] and first.answers == ["Noted."]
    assert server.answers() == [("POST", f"/tenants/{TENANT}/thor/{KEY1}/answer", f"Bearer {THOR_KEY}", {"answer": "do_it"})]
