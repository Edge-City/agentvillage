"""av-godconst, second mode: the non-voter elicitation cards (GC-ELICIT §11.4; docs/GODCONST-TELEGRAM-BALLOT.md,
section 11).

Fakes only: the bot, the buttons, the tap and the control plane. Every call goes through the real client (`cp_call`)
into a fake opener that routes on the request PATH with exact bodies, as the ballot suite does. The ballot's switch is
off throughout unless a test turns it on: the elicitation cards must work without it.
"""

from __future__ import annotations

import asyncio
import email.message
import io
import json
import logging
import os
import urllib.error
import urllib.parse
from datetime import datetime, timezone

import pytest


TEXT = "Elicit-Statement-Marker"
OWNER = 4242
DAY = datetime(2026, 10, 24, 5, 0, tzinfo=timezone.utc).timestamp()  # 10:30 IST
NIGHT = datetime(2026, 10, 24, 18, 0, tzinfo=timezone.utc).timestamp()  # 23:30 IST
TENANT = "0190a5b2-aaaa-4222-8333-444455556666"
KEY = "ballot_key_box"
EID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
EID2 = "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee"
POOL = "11111111-2222-4333-8444-555555555555"
EXPIRES_MS = int((DAY + 24 * 3600) * 1000)
READ = f"/tenants/{TENANT}/godconst/elicitation-cards"
RATE = f"/tenants/{TENANT}/godconst/elicitation-ratings"
SESSION_KEYS = {"elicitation_id", "nonce", "order", "expires_ms", "status", "started_at", "header_message_id", "page",
                "cards", "rated", "dropped", "send_failures"}


def run(coro):
    return asyncio.run(coro)


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
        self.sent, self.edits, self.fail = [], [], 0
        self._next = 100

    async def send_message(self, chat_id, text, parse_mode=None, reply_markup=None, disable_web_page_preview=None):
        if self.fail:
            self.fail -= 1
            raise RuntimeError("Forbidden: bot was blocked by the user")
        self._next += 1
        msg = Msg(self._next, chat_id, text, reply_markup, self)
        self.sent.append(msg)
        return msg

    async def edit_message_reply_markup(self, chat_id, message_id, reply_markup):
        self.edits.append((message_id, reply_markup))

    def cards(self):
        return [m for m in self.sent if m.reply_markup and m.reply_markup.inline_keyboard[0][0].callback_data.startswith("gce:r:")]

    def header(self):
        return next(m for m in self.sent if m.reply_markup and m.reply_markup.inline_keyboard[0][0].callback_data.startswith("gce:x:"))


class Server:
    """The control plane and the app's elicitation-ratings routes for one non-voter window."""

    def __init__(self, plugin, n=6):
        self.P = plugin
        self.order = [f"s{i:03d}" for i in range(1, n + 1)]
        self.saved = {}
        self.calls = []
        self.refuse = None
        self.unknown = set()
        self.revisions = 0
        with open(os.path.join(os.environ["HERMES_HOME"], ".env"), "w", encoding="utf-8") as handle:
            handle.write(f"CONTROL_PLANE_URL=http://127.0.0.1:9\nAV_GODCONST_BALLOT_KEY={KEY}\n")
        plugin._OPENER = FakeOpener(self)

    def __call__(self, op, body, home=None):
        return self.P.cp_call(op, body, home)

    def answer(self, path, body):
        self.calls.append((path, json.loads(json.dumps(body))))
        if path == READ:
            if set(body) != {"elicitation_id"}:
                return 400, {"error": "body_invalid"}
        elif path == RATE:
            if set(body) != {"elicitation_id", "ratings", "channel"} or body["channel"] != "telegram_card" or len(body["ratings"]) != 1:
                return 400, {"error": "body_invalid"}
        else:
            return 404, {"error": "not_found"}
        if self.refuse:
            return self.refuse[0], ({"error": self.refuse[1]} if self.refuse[1] else {})
        if path == READ:
            return 200, {"statements": [{"statement_id": sid, "text": f"{TEXT} {sid}", "origin": "odin" if i % 2 else "agent",
                                         "saved_rating": self.saved.get(sid)} for i, sid in enumerate(self.order)]}
        item = body["ratings"][0]
        if item["statement_id"] in self.unknown:
            return 422, {"error": "unknown_statement"}
        self.saved[item["statement_id"]] = item["rating"]
        self.revisions += 1
        return 200, {"state": "saved", "revision": self.revisions}


class _Response:
    def __init__(self, status, raw):
        self.status, self._raw = status, io.BytesIO(raw)

    def read(self, n=-1):
        return self._raw.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    def __init__(self, server):
        self.server = server

    def open(self, request, timeout=None):
        assert request.get_method() == "POST" and request.get_header("Authorization") == f"Bearer {KEY}"
        status, payload = self.server.answer(urllib.parse.urlsplit(request.full_url).path, json.loads(request.data))
        raw = json.dumps(payload).encode()
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, "refused", email.message.Message(), io.BytesIO(raw))
        return _Response(status, raw)


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
def elicit(home, monkeypatch):
    monkeypatch.setenv("AV_GODCONST_ELICIT_CARDS", "1")
    monkeypatch.setenv("AV_GODCONST_BALLOT", "0")
    return home


def write_trigger(home, ids=None, eid=EID, expires_ms=EXPIRES_MS, raw=None):
    path = os.path.join(home, "av-events", "godconst", "elicit-cards.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = raw if raw is not None else json.dumps({"elicitation_id": eid, "pool_id": POOL, "window_ms": 1761280000000,
                                                   "statement_ids": ids if ids is not None else [f"s{i:03d}" for i in range(1, 7)],
                                                   "expires_ms": expires_ms})
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(body)
    os.replace(tmp, path)
    return path


def remove_trigger(home):
    os.unlink(os.path.join(home, "av-events", "godconst", "elicit-cards.json"))


def stage_inject(home, name):
    directory = os.path.join(home, "av-events", "elicit", "inject")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("#trigger=opener\nhello")
    return path


def pass_(P, bot, server, now=DAY):
    return run(P.elicit_pass_once(bot, None, make_button, make_markup, now=now, reader=server))


def tap(P, server, msg, value=None, *, user=OWNER, data=None, clock=DAY, chat_type="private"):
    q = Query(data or msg.reply_markup.inline_keyboard[0][value - 1].callback_data, msg, user=user, chat_type=chat_type)
    handler = P.make_elicit_handler(None, make_button=make_button, make_markup=make_markup, caller=server, clock=lambda: clock)
    run(handler(type("Update", (), {"callback_query": q})()))
    return q


def ledger(home):
    with open(os.path.join(home, "av-godconst", "elicit.json"), encoding="utf-8") as handle:
        return json.load(handle)


def marker(home):
    return os.path.join(home, "av-events", "godconst", "page-open")


def assert_nothing_private_on_disk(home):
    """Ids, positions and message ids only: no statement text, no rating value, no origin, no key."""
    path = os.path.join(home, "av-godconst", "elicit.json")
    raw = open(path, encoding="utf-8").read()
    assert TEXT not in raw and "rating" not in raw and "saved" not in raw and "odin" not in raw and KEY not in raw
    assert oct(os.stat(path).st_mode & 0o777) == "0o600"
    stored = json.loads(raw)
    assert {"v", "session", "ended"} <= set(stored) <= {"v", "session", "ended", "start_failures"}
    if "start_failures" in stored:
        assert set(stored["start_failures"]) == {"elicitation_id", "n"}
    session = stored["session"]
    if session is not None:
        assert set(session) == SESSION_KEYS
        assert all(type(p) is int for p in session["rated"] + session["dropped"])
        for position, card in session["cards"].items():
            assert position.isdigit() and set(card) == {"message_id"} and type(card["message_id"]) is int
    for item in stored["ended"]:
        assert set(item) == {"elicitation_id", "nonce", "status", "at"}
    assert not os.path.exists(marker(home)) or os.path.getsize(marker(home)) == 0
    assert not os.path.exists(os.path.join(home, "av-godconst", "ballot.json"))  # the ballot is never touched


FU = "Follow-up (not your ballot)"


def first_line(msg):
    return msg.text.splitlines()[0]


def open_ballot_page(P, home, status="active"):
    """A ballot ledger with a sent, unrated card inside its window (the ballot mode's open page)."""
    P.save_ledger({"v": 1, "session": {
        "pool_id": POOL, "pool_sha256": "a" * 64, "order_rule": "godconst-order-v2", "nonce": "BALLOT12", "order": ["b1", "b2"],
        "closes_at": "2026-10-25T05:00:00.000Z", "status": status, "started_at": "x", "header_message_id": 1, "page": 0,
        "cards": {"0": {"message_id": 2, "submit": False}}, "rated": [], "final_sent": False, "send_failures": 0}})


def close_ballot(P):
    P.save_ledger({"v": 1, "session": None})


# --------------------------------------------------------------------------- pure logic


def test_callbacks_trigger_and_cards_shapes(plugin):
    L = plugin.L
    assert L.parse_elicit_callback(L.elicit_rating_callback("AbCd_-12", 29, 5)) == ("rate", "AbCd_-12", 29, 5)
    assert L.parse_elicit_callback(L.elicit_stop_callback("AbCd_-12")) == ("stop", "AbCd_-12")
    for bad in ("gcb:r:AbCd_-12:1:3", "gce:r:AbCd_-12:1:6", "gce:g:AbCd_-12", "gce:s:AbCd_-12", "gce:r:short:1:3", None, 3):
        assert L.parse_elicit_callback(bad) is None
    assert L.parse_callback("gce:r:AbCd_-12:1:3") is None  # the ballot handler never takes an elicitation tap
    good = {"elicitation_id": EID, "pool_id": POOL, "window_ms": 1, "statement_ids": ["s001"], "expires_ms": 2, "extra": 1}
    assert L.valid_trigger(good) == {k: v for k, v in good.items() if k != "extra"}
    for broken in ({**good, "elicitation_id": "x"}, {**good, "statement_ids": []}, {**good, "statement_ids": ["s001", "s001"]},
                   {**good, "expires_ms": True}, {**good, "window_ms": 0}, {**good, "statement_ids": ["bad id!"]}, [], None):
        assert L.valid_trigger(broken) is None
    data = {"statements": [{"statement_id": "s002", "text": "b", "origin": "odin", "saved_rating": None},
                           {"statement_id": "s001", "text": "a", "origin": "agent", "saved_rating": 4},
                           {"statement_id": "s009", "text": "c", "origin": "agent", "saved_rating": None}]}
    assert L.valid_cards(data, ["s001", "s002"]) == [{"id": "s002", "text": "b", "saved": None}, {"id": "s001", "text": "a", "saved": 4}]
    assert L.valid_cards({"statements": [{"statement_id": "s001", "text": "a", "saved_rating": 6}]}, ["s001"]) is None
    assert L.valid_cards({}, ["s001"]) is None


def test_final_and_temporary_refusal_codes(plugin):
    final = {"not_non_voter", "voter_window", "withdrawn", "elicitation_withdrawn", "elicitation_not_found", "research_grant_required", "expired"}
    assert final <= plugin.ELICIT_END_CODES
    assert not {"window_not_settled", "not_settled", "not_enabled", "unauthorized", "unknown_statement"} & plugin.ELICIT_END_CODES
    R = plugin.Reply
    assert plugin._final_refusal(R(403, {}, "not_non_voter"))
    assert not plugin._final_refusal(R(503, {}, "withdrawn"))  # any 5xx is temporary
    assert not plugin._final_refusal(R(404, {}, "http_404"))  # the switched-off 404 with no code
    assert not plugin._final_refusal(R(None, None, "network"))


# --------------------------------------------------------------------------- gating and the trigger


@pytest.mark.parametrize("value", [None, "", "0", "true", "yes", "on", " 2"])
def test_only_exactly_1_switches_it_on(plugin, elicit, monkeypatch, value):
    if value is None:
        monkeypatch.delenv("AV_GODCONST_ELICIT_CARDS")
    else:
        monkeypatch.setenv("AV_GODCONST_ELICIT_CARDS", value)
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    assert pass_(plugin, bot, server) == "off"
    assert bot.sent == [] and server.calls == []


def test_the_switch_can_come_from_the_dotenv_and_works_with_the_ballot_off(plugin, elicit, monkeypatch):
    monkeypatch.delenv("AV_GODCONST_ELICIT_CARDS")
    monkeypatch.delenv("AV_GODCONST_BALLOT")
    bot, server = Bot(), Server(plugin)
    with open(os.path.join(elicit, ".env"), "a", encoding="utf-8") as handle:
        handle.write("AV_GODCONST_ELICIT_CARDS=1\n")
    assert plugin.ballot_on() is False and plugin.elicit_on() is True
    write_trigger(elicit)
    assert pass_(plugin, bot, server) == "sent"
    assert len(bot.cards()) == 2
    assert run(plugin.pass_once(bot, None, make_button, make_markup, now=DAY, reader=server)) == "off"


def test_no_file_malformed_expired_or_unsafe_shows_nothing(plugin, elicit, monkeypatch):
    bot, server = Bot(), Server(plugin)
    assert pass_(plugin, bot, server) == "no_trigger"
    path = write_trigger(elicit)
    real_uid = plugin._uid()
    monkeypatch.setattr(plugin, "_uid", lambda: real_uid + 1)
    assert pass_(plugin, bot, server) == "trigger_foreign_owner"
    monkeypatch.setattr(plugin, "_uid", lambda: real_uid)
    os.chmod(path, 0o666)
    assert pass_(plugin, bot, server) == "trigger_not_private"
    write_trigger(elicit, raw="{not json")
    os.chmod(path, 0o600)
    assert pass_(plugin, bot, server) == "trigger_bad_shape"
    write_trigger(elicit, raw=json.dumps({"elicitation_id": EID}))
    assert pass_(plugin, bot, server) == "trigger_bad_shape"
    write_trigger(elicit, raw=" " * (plugin.ELICIT_TRIGGER_MAX_BYTES + 1))
    assert pass_(plugin, bot, server) == "trigger_too_big"
    write_trigger(elicit, expires_ms=int(DAY * 1000) - 1)
    assert pass_(plugin, bot, server) == "expired"
    os.unlink(path)
    os.symlink(os.path.join(elicit, ".env"), path)
    assert pass_(plugin, bot, server) == "trigger_not_regular"
    os.unlink(path)
    os.mkfifo(path)  # opened without blocking: the pass never hangs on a FIFO
    assert pass_(plugin, bot, server) == "trigger_not_regular"
    assert bot.sent == [] and server.calls == []


def test_a_pending_opener_holds_the_page_and_the_next_pair_follows_once_it_clears(plugin, elicit, caplog):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    txt = stage_inject(elicit, "1761280000000-open.txt")
    assert pass_(plugin, bot, server) == "opener_pending"
    os.rename(txt, txt[:-4] + ".sending")
    assert pass_(plugin, bot, server) == "opener_pending"
    assert bot.sent == [] and server.calls == []
    os.rename(txt[:-4] + ".sending", txt[:-4] + ".done")
    assert pass_(plugin, bot, server) == "sent"
    # Mid-page, a new staged opener holds the next pair even after a tap rates the current one.
    nxt = stage_inject(elicit, "1761280000001-next.txt")
    first, second = bot.cards()
    tap(plugin, server, first, 3)
    tap(plugin, server, second, 3)
    assert len(bot.cards()) == 2
    assert pass_(plugin, bot, server, now=DAY + 60) == "opener_pending"
    os.rename(nxt, nxt[:-4] + ".done")
    assert pass_(plugin, bot, server, now=DAY + 120) == "sent"
    assert [first_line(c) for c in bot.cards()[2:]] == [f"{FU} · Statement 3 of 6", f"{FU} · Statement 4 of 6"]
    # An inject directory that cannot be listed holds too, and says so.
    caplog.set_level(logging.INFO)
    inject = os.path.join(elicit, "av-events", "elicit", "inject")
    for name in os.listdir(inject):
        os.unlink(os.path.join(inject, name))
    os.rmdir(inject)
    open(inject, "w").close()
    assert plugin.opener_pending() is True
    assert "outcome=inject_list_failed" in caplog.text


def test_no_page_at_night_and_no_home_chat(plugin, elicit, monkeypatch):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    assert pass_(plugin, bot, server, now=NIGHT) == "waiting_daytime"
    monkeypatch.delenv("TELEGRAM_HOME_CHANNEL")
    assert pass_(plugin, bot, server) == "no_home_chat"
    assert bot.sent == [] and server.calls == []


# --------------------------------------------------------------------------- the page


def test_start_sends_a_labelled_header_and_the_first_pair_of_the_files_statements(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit, ids=["s005", "s002", "s003"])  # the read's order wins; s001, s004, s006 are never shown
    assert pass_(plugin, bot, server) == "sent"
    header, *cards = bot.sent
    assert first_line(header) == f"{FU}: 3 constitution statements to rate (optional)"
    assert "separate from the official constitution ballot" in header.text and "Tap again to change a rating" in header.text
    assert "5  Strongly support inclusion" in header.text and "Open until 10:30 IST, Sun 25 Oct." in header.text
    assert "Submit" not in header.text and "remind" not in header.text.lower()
    assert [[b.text for b in row] for row in header.reply_markup.inline_keyboard] == [["Stop these cards"]]
    assert [first_line(c) for c in cards] == [f"{FU} · Statement 1 of 3", f"{FU} · Statement 2 of 3"]
    assert f"{TEXT} s002" in cards[0].text and f"{TEXT} s003" in cards[1].text
    assert "odin" not in cards[0].text.lower() and "agent" not in cards[0].text.lower()
    assert [b.text for b in cards[0].reply_markup.inline_keyboard[0]] == ["1", "2", "3", "4", "5"]
    assert len(cards[0].reply_markup.inline_keyboard) == 1  # no Submit
    assert server.calls == [(READ, {"elicitation_id": EID})]
    assert ledger(elicit)["session"]["order"] == ["s002", "s003", "s005"]
    assert os.path.exists(marker(elicit))
    assert_nothing_private_on_disk(elicit)
    assert pass_(plugin, bot, server, now=DAY + 60) == "idle"
    assert len(bot.sent) == 3 and len(server.calls) == 1


def test_taps_post_one_rating_advance_and_revisions_still_save_after_all_are_rated(plugin, elicit):
    bot, server = Bot(), Server(plugin, n=3)
    write_trigger(elicit, ids=["s001", "s002", "s003"])
    pass_(plugin, bot, server)
    first, second = bot.cards()
    q = tap(plugin, server, first, 4)
    assert q.answers == ["Saved: Support inclusion"]
    assert [b.text for b in q.edited[0].inline_keyboard[0]] == ["1", "2", "3", "✅ 4", "5"]
    assert server.calls[-1] == (RATE, {"elicitation_id": EID, "ratings": [{"statement_id": "s001", "rating": 4}], "channel": "telegram_card"})
    assert len(bot.cards()) == 2 and os.path.exists(marker(elicit))
    q = tap(plugin, server, first, 2)
    assert q.answers == ["Saved: Oppose inclusion (changed)"]
    tap(plugin, server, second, 5)
    third = bot.cards()[2]
    assert first_line(third) == f"{FU} · Statement 3 of 3"
    tap(plugin, server, third, 1)
    assert bot.sent[-1].text.startswith(f"{FU}: all 3 statements rated. Thank you: your ratings are saved.")
    assert "change a rating until 10:30 IST, Sun 25 Oct." in bot.sent[-1].text
    stored = ledger(elicit)
    assert stored["session"]["status"] == "done" and stored["ended"] == []
    assert not os.path.exists(marker(elicit))
    assert_nothing_private_on_disk(elicit)
    # Re-taps keep saving (revisions) with no new sends; the pass sends nothing.
    sent = len(bot.sent)
    assert tap(plugin, server, third, 2).answers == ["Saved: Oppose inclusion (changed)"]
    assert server.saved == {"s001": 2, "s002": 5, "s003": 2}
    assert pass_(plugin, bot, server, now=DAY + 600) == "idle"
    assert len(bot.sent) == sent and not os.path.exists(marker(elicit))
    # Until withdrawal (confirmed over two passes) ends it; then closed for good.
    remove_trigger(elicit)
    assert pass_(plugin, bot, server, now=DAY + 660) == "trigger_missing"
    assert pass_(plugin, bot, server, now=DAY + 720) == "ended_withdrawn"
    calls = len(server.calls)
    assert tap(plugin, server, first, 3).answers == ["This rating has closed."]
    write_trigger(elicit, ids=["s001", "s002", "s003"])
    assert pass_(plugin, bot, server, now=DAY + 780) == "ended_here"
    assert len(server.calls) == calls


def test_saved_ratings_are_prefilled_and_a_fully_rated_pair_moves_on(plugin, elicit):
    bot, server = Bot(), Server(plugin, n=4)
    server.saved = {"s001": 2, "s002": 5, "s003": 4}
    write_trigger(elicit, ids=["s001", "s002", "s003", "s004"])
    pass_(plugin, bot, server)
    cards = bot.cards()
    assert len(cards) == 4
    assert [b.text for b in cards[0].reply_markup.inline_keyboard[0]] == ["1", "✅ 2", "3", "4", "5"]
    assert [b.text for b in cards[2].reply_markup.inline_keyboard[0]] == ["1", "2", "3", "✅ 4", "5"]
    assert [b.text for b in cards[3].reply_markup.inline_keyboard[0]] == ["1", "2", "3", "4", "5"]
    assert ledger(elicit)["session"]["rated"] == [0, 1, 2]
    tap(plugin, server, cards[3], 3)
    assert bot.sent[-1].text.startswith(f"{FU}: all 4 statements rated.")
    bot2 = Bot()
    write_trigger(elicit, eid=EID2, ids=["s001"])
    assert pass_(plugin, bot2, server) == "all_rated"
    assert bot2.sent == [] and ledger(elicit)["ended"][-1]["status"] == "all_rated"


def test_an_unknown_statement_drops_only_that_card(plugin, elicit):
    bot, server = Bot(), Server(plugin, n=4)
    server.unknown = {"s002"}
    write_trigger(elicit, ids=["s001", "s002", "s003", "s004"])
    pass_(plugin, bot, server)
    first, second = bot.cards()
    again = second.reply_markup.inline_keyboard[0][3].callback_data
    q = tap(plugin, server, second, 3)
    assert q.answers == ["This statement is no longer available."] and q.edited == [None]
    assert ledger(elicit)["session"]["dropped"] == [1] and ledger(elicit)["session"]["status"] == "active"
    calls = len(server.calls)
    assert tap(plugin, server, second, data=again).answers == ["This statement is no longer available."]
    assert len(server.calls) == calls  # no call for a dropped card
    tap(plugin, server, first, 5)  # the pair needs nothing more: the next pair goes
    assert [first_line(c) for c in bot.cards()[-2:]] == [f"{FU} · Statement 3 of 4", f"{FU} · Statement 4 of 4"]
    for card in bot.cards()[-2:]:
        tap(plugin, server, card, 1)
    assert bot.sent[-1].text.startswith(f"{FU}: all 3 statements rated.")
    assert_nothing_private_on_disk(elicit)


def test_a_statement_the_read_no_longer_returns_is_dropped(plugin, elicit):
    bot, server = Bot(), Server(plugin, n=4)
    write_trigger(elicit, ids=["s001", "s002", "s003", "s004"])
    pass_(plugin, bot, server)
    first, second = bot.cards()
    server.order.remove("s004")
    tap(plugin, server, first, 2)
    tap(plugin, server, second, 2)
    assert [first_line(c) for c in bot.cards()[2:]] == [f"{FU} · Statement 3 of 4"]
    assert ledger(elicit)["session"]["dropped"] == [3]
    tap(plugin, server, bot.cards()[2], 2)
    assert ledger(elicit)["session"]["status"] == "done"


def test_a_changed_order_ends_it_instead_of_rereading(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    server.order.reverse()
    first, second = bot.cards()
    tap(plugin, server, first, 2)
    tap(plugin, server, second, 2)
    stored = ledger(elicit)
    assert stored["session"] is None and stored["ended"][-1]["status"] == "order_changed"
    reads = sum(1 for path, _ in server.calls if path == READ)
    assert pass_(plugin, bot, server, now=DAY + 60) == "ended_here"
    assert sum(1 for path, _ in server.calls if path == READ) == reads


def test_failed_sends_retry_and_three_in_a_row_end_it_header_included(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    bot.fail = 1
    assert pass_(plugin, bot, server) == "send_failed"
    assert ledger(elicit)["session"] is None and ledger(elicit)["start_failures"] == {"elicitation_id": EID, "n": 1}
    assert_nothing_private_on_disk(elicit)
    assert pass_(plugin, bot, server, now=DAY + 60) == "sent"
    assert "start_failures" not in ledger(elicit)
    first, second = bot.cards()
    tap(plugin, server, first, 1)
    bot.fail = 1
    tap(plugin, server, second, 1)
    assert len(bot.cards()) == 2 and ledger(elicit)["session"]["send_failures"] == 1
    assert pass_(plugin, bot, server, now=DAY + 120) == "sent"
    assert len(bot.cards()) == 4 and ledger(elicit)["session"]["send_failures"] == 0
    tap(plugin, server, bot.cards()[2], 1)
    bot.fail = 99
    tap(plugin, server, bot.cards()[3], 1)
    pass_(plugin, bot, server, now=DAY + 180)
    pass_(plugin, bot, server, now=DAY + 240)
    stored = ledger(elicit)
    assert stored["session"] is None and stored["ended"][-1]["status"] == "undeliverable"
    # The header alone failing three times in a row ends a new elicitation too.
    bot2 = Bot()
    bot2.fail = 99
    write_trigger(elicit, eid=EID2)
    assert [pass_(plugin, bot2, server, now=DAY + 300 + 60 * i) for i in range(3)] == ["send_failed"] * 3
    assert ledger(elicit)["ended"][-1] == {**ledger(elicit)["ended"][-1], "elicitation_id": EID2, "status": "undeliverable"}
    assert pass_(plugin, bot2, server, now=DAY + 600) == "ended_here"


# --------------------------------------------------------------------------- the owner rule and the lock


def test_only_the_own_resident_in_their_own_dm(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    first = bot.cards()[0]
    calls = len(server.calls)
    assert tap(plugin, server, first, 3, user=999).answers == ["This card is not yours"]
    assert tap(plugin, server, first, 3, chat_type="group").answers == ["This card is not yours"]
    assert len(server.calls) == calls and server.saved == {}
    first.chat.type = "private"
    assert tap(plugin, server, first, data="gce:r:short:1:3").answers == ["This button is not valid."]


def test_a_tap_saves_and_answers_while_a_pass_holds_the_lock(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    first = bot.cards()[0]
    q = Query(first.reply_markup.inline_keyboard[0][2].callback_data, first)
    handler = plugin.make_elicit_handler(None, make_button=make_button, make_markup=make_markup, caller=server, clock=lambda: DAY)

    async def scenario():
        lock = plugin._elicit_lock()
        await lock.acquire()  # a pass mid-send
        task = asyncio.create_task(handler(type("Update", (), {"callback_query": q})()))
        for _ in range(500):
            if q.answers:
                break
            await asyncio.sleep(0.01)
        during = (list(q.answers), dict(server.saved), ledger(elicit)["session"]["rated"])
        lock.release()
        await asyncio.wait_for(task, 5)
        return during

    answers, saved, rated = run(scenario())
    assert answers == ["Saved: Neutral"] and saved == {"s001": 3}
    assert rated == []  # the ledger merge waited for the lock ...
    assert ledger(elicit)["session"]["rated"] == [0]  # ... and landed after it


def test_a_tap_never_brings_back_a_session_ended_meanwhile(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    first = bot.cards()[0]
    q = Query(first.reply_markup.inline_keyboard[0][2].callback_data, first)
    handler = plugin.make_elicit_handler(None, make_button=make_button, make_markup=make_markup, caller=server, clock=lambda: DAY)

    async def scenario():
        lock = plugin._elicit_lock()
        await lock.acquire()
        task = asyncio.create_task(handler(type("Update", (), {"callback_query": q})()))
        for _ in range(500):
            if q.answers:
                break
            await asyncio.sleep(0.01)
        stored = ledger(elicit)
        plugin.end_elicit(stored, "stopped", now=DAY)  # Stop pressed meanwhile
        lock.release()
        await asyncio.wait_for(task, 5)

    run(scenario())
    stored = ledger(elicit)
    assert stored["session"] is None and stored["ended"][-1]["status"] == "stopped"


# --------------------------------------------------------------------------- endings


def test_withdrawal_is_confirmed_on_two_passes_before_it_ends(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    remove_trigger(elicit)
    assert pass_(plugin, bot, server, now=DAY + 60) == "trigger_missing"
    assert ledger(elicit)["session"] is not None
    calls = len(server.calls)
    # A tap while the file is missing saves nothing and ends nothing.
    assert tap(plugin, server, bot.cards()[0], 3).answers == ["This rating has closed."]
    assert len(server.calls) == calls and ledger(elicit)["session"] is not None
    # The file back between passes resets the count.
    write_trigger(elicit)
    assert pass_(plugin, bot, server, now=DAY + 120) == "idle"
    remove_trigger(elicit)
    assert pass_(plugin, bot, server, now=DAY + 180) == "trigger_missing"
    assert pass_(plugin, bot, server, now=DAY + 240) == "ended_withdrawn"
    assert ledger(elicit)["ended"][-1]["status"] == "withdrawn" and not os.path.exists(marker(elicit))
    assert tap(plugin, server, bot.cards()[0], 3).answers == ["This rating has closed."]
    write_trigger(elicit)
    assert pass_(plugin, bot, server, now=DAY + 300) == "ended_here"


def test_expiry_ends_it_on_the_pass_and_on_a_tap(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    after = EXPIRES_MS / 1000.0 + 1
    calls = len(server.calls)
    assert tap(plugin, server, bot.cards()[0], 3, clock=after).answers == ["This rating has closed."]
    assert len(server.calls) == calls and ledger(elicit)["ended"][-1]["status"] == "expired"
    assert pass_(plugin, bot, server, now=after) == "expired"


def test_a_new_elicitation_file_replaces_the_old_session(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    old = bot.cards()[0]
    write_trigger(elicit, eid=EID2)
    assert pass_(plugin, bot, server, now=DAY + 60) == "sent"
    stored = ledger(elicit)
    assert stored["session"]["elicitation_id"] == EID2 and stored["ended"][-1] == {**stored["ended"][-1], "elicitation_id": EID, "status": "replaced"}
    assert tap(plugin, server, old, 3).answers == ["This rating has closed."]


@pytest.mark.parametrize("code", ["not_non_voter", "voter_window", "withdrawn", "elicitation_withdrawn", "elicitation_not_found",
                                  "research_grant_required", "expired"])
def test_a_final_refused_read_never_starts_and_never_retries(plugin, elicit, code):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    server.refuse = (403, code)
    assert pass_(plugin, bot, server) == f"refused_{code}"
    assert bot.sent == [] and ledger(elicit)["ended"][-1]["status"] == "refused"
    server.refuse = None
    assert pass_(plugin, bot, server, now=DAY + 600) == "ended_here"
    assert bot.sent == []


@pytest.mark.parametrize("refuse,code", [((409, "window_not_settled"), "window_not_settled"), ((503, "withdrawn"), "withdrawn"),
                                         ((502, None), "http_502"), ((404, None), "http_404"), ((403, "not_enabled"), "not_enabled")])
def test_a_temporary_read_failure_backs_off_and_retries_until_expiry(plugin, elicit, refuse, code):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    server.refuse = refuse
    assert pass_(plugin, bot, server) == code
    assert pass_(plugin, bot, server, now=DAY + 60) == "not_due"  # the 5-minute backoff
    assert pass_(plugin, bot, server, now=DAY + 301) == code
    assert bot.sent == [] and not os.path.exists(os.path.join(elicit, "av-godconst", "elicit.json"))
    assert sum(1 for path, _ in server.calls if path == READ) == 2
    server.refuse = None
    assert pass_(plugin, bot, server, now=DAY + 602) == "sent"
    # Past expiry nothing is read again.
    server.refuse = refuse
    assert pass_(plugin, bot, server, now=EXPIRES_MS / 1000.0) == "ended_expired"


def test_a_temporary_refused_save_keeps_the_card(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    for refuse in ((409, "window_not_settled"), (500, None), (404, None), (403, "not_enabled")):
        server.refuse = refuse
        q = tap(plugin, server, bot.cards()[0], 3)
        assert q.answers == ["Could not save that. Tap again in a moment."] and q.edited == []
    assert ledger(elicit)["session"] is not None


def test_a_final_refused_save_ends_it(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    server.refuse = (409, "elicitation_withdrawn")
    assert tap(plugin, server, bot.cards()[0], 3).answers == ["This rating has closed."]
    stored = ledger(elicit)
    assert stored["session"] is None and stored["ended"][-1]["status"] == "refused"
    assert not os.path.exists(marker(elicit))


def test_stop_ends_it_and_keeps_what_was_saved(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    tap(plugin, server, bot.cards()[0], 4)
    header = bot.header()
    q = tap(plugin, server, header, data=header.reply_markup.inline_keyboard[0][0].callback_data)
    assert q.answers == ["Stopped. The ratings you gave are kept."] and q.edited == [None]
    assert bot.sent[-1].text == f"{FU}: stopped, no more statement cards. The ratings you gave are kept."
    stored = ledger(elicit)
    assert stored["session"] is None and stored["ended"][-1]["status"] == "stopped"
    assert server.saved == {"s001": 4} and not os.path.exists(marker(elicit))
    assert tap(plugin, server, bot.cards()[1], 3).answers == ["This rating has closed."]
    assert pass_(plugin, bot, server, now=DAY + 600) == "ended_here"
    assert_nothing_private_on_disk(elicit)


def test_a_malformed_file_holds_without_ending(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    write_trigger(elicit, raw="{")
    assert pass_(plugin, bot, server, now=DAY + 60) == "trigger_bad_shape"
    q = tap(plugin, server, bot.cards()[0], 3)
    assert q.answers == ["Could not save that. Tap again in a moment."] and server.saved == {}
    assert ledger(elicit)["session"] is not None
    write_trigger(elicit)
    assert tap(plugin, server, bot.cards()[0], 3).answers == ["Saved: Neutral"]


def test_tombstones_are_bounded(plugin, elicit):
    stored = plugin.empty_elicit_ledger()
    for i in range(plugin.ELICIT_ENDED_MAX + 5):
        plugin._tombstone(stored, f"{i:08d}-bbbb-4ccc-8ddd-eeeeeeeeeeee", None, "done", DAY)
    assert len(stored["ended"]) == plugin.ELICIT_ENDED_MAX


# --------------------------------------------------------------------------- both modes, the shared marker


def test_both_modes_at_once_the_ballot_goes_first(plugin, elicit, monkeypatch):
    monkeypatch.setenv("AV_GODCONST_BALLOT", "1")
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    open_ballot_page(plugin, elicit)
    assert pass_(plugin, bot, server) == "ballot_active"
    assert bot.sent == [] and server.calls == []
    # A ballot session still active with no page open (between pairs) holds as well.
    open_ballot_page(plugin, elicit)
    stored = json.load(open(plugin.ledger_path()))
    stored["session"]["rated"] = [0]
    plugin.save_ledger(stored)
    assert plugin.page_is_open(stored["session"], DAY) is False
    assert pass_(plugin, bot, server) == "ballot_active"
    # A stopped ballot does not hold.
    open_ballot_page(plugin, elicit, status="stopped")
    assert pass_(plugin, bot, server) == "sent"
    assert all(first_line(c).startswith(FU) for c in bot.cards())
    # The ballot active again mid-page: a tap saves, the next pair waits for the ballot.
    open_ballot_page(plugin, elicit)
    first, second = bot.cards()
    tap(plugin, server, first, 4)
    tap(plugin, server, second, 4)
    assert server.saved == {"s001": 4, "s002": 4} and len(bot.cards()) == 2
    assert pass_(plugin, bot, server, now=DAY + 60) == "ballot_active"
    close_ballot(plugin)
    assert pass_(plugin, bot, server, now=DAY + 120) == "sent"
    assert len(bot.cards()) == 4
    # Neither mode's state crossed: the ballot ledger is the test's own, the elicitation's calls only its routes.
    assert all(path in (READ, RATE) for path, _ in server.calls)
    assert json.load(open(plugin.ledger_path())) == {"v": 1, "session": None}


def test_the_marker_stays_while_either_mode_has_an_open_page(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    assert os.path.exists(marker(elicit))
    open_ballot_page(plugin, elicit)
    plugin.set_page_open(True)
    # The elicitation's pair is rated (next pair held by the ballot): the ballot's page still holds the marker.
    for card in bot.cards():
        tap(plugin, server, card, 3)
    assert not plugin.elicit_page_open_now() and os.path.exists(marker(elicit))
    close_ballot(plugin)
    plugin.set_page_open(False)
    assert not os.path.exists(marker(elicit))


def test_the_ballot_never_removes_the_elicitation_pages_marker(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    assert os.path.exists(marker(elicit))
    plugin.set_page_open(False)
    assert os.path.exists(marker(elicit))
    assert plugin.reconcile_page_open(now=DAY + 10) is True and os.path.exists(marker(elicit))
    assert not os.path.exists(os.path.join(elicit, "av-godconst", "ballot.json"))
    assert plugin.reconcile_page_open(now=EXPIRES_MS / 1000.0 + 1) is False and not os.path.exists(marker(elicit))


def test_a_corrupt_typed_ledger_of_either_mode_counts_as_not_open(plugin, elicit, caplog):
    caplog.set_level(logging.INFO)
    plugin.save_ledger({"v": 1, "session": {"status": "active", "page": "x", "order": 5, "closes_at": 7}})
    plugin._write_marker(True)
    plugin.set_elicit_page_open(False)  # the ballot side cannot be read: treated as not open
    assert not os.path.exists(marker(elicit))
    assert plugin.ballot_holds_elicit(now=DAY) is False
    assert "outcome=page_marker_unknown mode=ballot" in caplog.text
    plugin.save_elicit_ledger({"v": 1, "session": {"status": "active", "page": "x", "order": None}, "ended": []})
    plugin._write_marker(True)
    plugin.save_ledger({"v": 1, "session": None})
    plugin.set_page_open(False)
    assert not os.path.exists(marker(elicit))
    assert plugin.reconcile_page_open(now=DAY) is False
    assert "outcome=page_marker_unknown mode=elicit" in caplog.text


def test_a_rated_pair_clears_the_marker_until_the_next_pair_is_sent(plugin, elicit):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    stage_inject(elicit, "1761280000001-next.txt")
    first, second = bot.cards()
    tap(plugin, server, first, 1)
    assert os.path.exists(marker(elicit))
    tap(plugin, server, second, 1)
    assert not os.path.exists(marker(elicit))


# --------------------------------------------------------------------------- privacy, wiring, custody, fail-open


def test_logs_carry_codes_and_counts_only(plugin, elicit, caplog):
    caplog.set_level(logging.DEBUG)
    bot, server = Bot(), Server(plugin, n=2)
    write_trigger(elicit, ids=["s001", "s002"])
    pass_(plugin, bot, server)
    first, second = bot.cards()
    tap(plugin, server, first, 5)
    tap(plugin, server, second, 1, user=999)
    tap(plugin, server, second, 2)
    remove_trigger(elicit)
    pass_(plugin, bot, server, now=DAY + 60)
    pass_(plugin, bot, server, now=DAY + 120)
    lines = "\n".join(r.getMessage() for r in caplog.records)
    assert "outcome=elicit_saved" in lines and "outcome=elicit_all_rated" in lines and "outcome=elicit_ended status=withdrawn" in lines
    for secret in (TEXT, KEY, EID, "s001", "s002", "gce:", str(OWNER), "999", "Support", "Strongly"):
        assert secret not in lines
    assert_nothing_private_on_disk(elicit)


def test_nothing_is_injected_or_emitted(plugin, elicit):
    calls = []

    class Ctx:
        def __getattr__(self, name):
            def record(*args, **kwargs):
                calls.append(name)
            return record

    plugin.register(Ctx())
    assert calls == ["register_platform_handler"]
    source = open(plugin.__file__, encoding="utf-8").read()
    assert "inject_message" not in source and "emit_event" not in source


def test_the_factory_wires_both_handlers_and_both_passes(plugin, elicit):
    pytest.importorskip("telegram")
    handlers, jobs = [], []

    class JobQueue:
        def run_repeating(self, callback, interval, first, name):
            jobs.append((callback, interval, name))

    app = type("App", (), {"add_handler": lambda self, h: handlers.append(h), "job_queue": JobQueue(), "bot": Bot()})()
    plugin._wire_telegram(app, None)
    assert [h.pattern.pattern for h in handlers] == ["^gcb:", "^gce:"] and all(h.block is False for h in handlers)
    assert len(jobs) == 1 and jobs[0][1] == plugin.PASS_INTERVAL_S
    seen = []

    async def fake_ballot(*a, **k):
        seen.append("ballot")

    async def fake_elicit(*a, **k):
        seen.append("elicit")

    plugin.pass_once, plugin.elicit_pass_once = fake_ballot, fake_elicit
    run(jobs[0][0]())
    assert seen == ["ballot", "elicit"]


def test_the_pass_and_the_tap_never_raise(plugin, elicit, monkeypatch):
    bot, server = Bot(), Server(plugin)
    write_trigger(elicit)
    pass_(plugin, bot, server)
    card = bot.cards()[0]

    def boom(*a, **k):
        raise RuntimeError("x")

    # The control plane client raising (a programming error), in the pass's read and the tap's save.
    second = bot.cards()[1]
    tap(plugin, server, card, 3)
    assert tap(plugin, boom, second, 3).answers == ["Could not save that. Tap again in a moment."]
    stored = ledger(elicit)
    stored["session"]["rated"] = [0, 1]
    plugin.save_elicit_ledger(stored)
    assert run(plugin.elicit_pass_once(bot, None, make_button, make_markup, now=DAY + 60, reader=boom)) == "pass_error"
    # Telegram raising on every call: sends and edits are swallowed.
    class Broken(Bot):
        async def send_message(self, **kw):
            raise RuntimeError("down")

        async def edit_message_reply_markup(self, **kw):
            raise RuntimeError("down")

    assert pass_(plugin, Broken(), server, now=DAY + 120) == "sent"
    # Any helper raising.
    for name in ("read_elicit_trigger", "load_elicit_ledger", "opener_pending", "home_chat_id"):
        with monkeypatch.context() as m:
            m.setattr(plugin, name, boom)
            assert pass_(plugin, bot, server, now=DAY + 900) in ("pass_error", "idle")
            q = tap(plugin, server, card, 2)
            assert len(q.answers) == 1
    # An answer that itself raises.
    q = Query(card.reply_markup.inline_keyboard[0][1].callback_data, card)

    async def bad_answer(text=None):
        raise RuntimeError("expired query")

    q.answer = bad_answer
    handler = plugin.make_elicit_handler(None, make_button=make_button, make_markup=make_markup, caller=boom, clock=lambda: DAY)
    run(handler(type("Update", (), {"callback_query": q})()))


def test_the_ballot_key_stays_in_custody(plugin):
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(plugin.__file__))))
    with open(os.path.join(root, "plugins", "av-approval", "custody_keys.json"), encoding="utf-8") as handle:
        names = json.load(handle)["names"]
    assert names["AV_GODCONST_BALLOT_KEY"]["decision"] == "strip"
    assert plugin.CREDENTIAL_ENV == "AV_GODCONST_BALLOT_KEY"
    with open(os.path.join(root, "plugins", "av-approval", "_custody.py"), encoding="utf-8") as handle:
        assert '"AV_GODCONST_BALLOT_KEY"' in handle.read()
