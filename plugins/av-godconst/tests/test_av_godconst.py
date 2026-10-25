"""av-godconst: the GODCONST ballot as Telegram button cards (docs/GODCONST-TELEGRAM-BALLOT.md).

Fakes only: the bot, the buttons, the tap and the control plane (a dict-backed ballot that merges taps per statement,
as the app does). Every call goes through the real client (`cp_call`) into a fake opener, and the fake control plane
routes on the request PATH with the cp's strict bodies (index.js + godconst-ballot.js parseBody), never on an op
name. The wire tests run the real HTTP client against a loopback server.
"""

from __future__ import annotations

import asyncio
import email.message
import http.server
import io
import json
import logging
import os
import threading
import urllib.error
import urllib.parse
from datetime import datetime, timezone

import pytest


TEXT = "Statement-Text-Marker"
SHA = "a" * 64
POOL = "11111111-2222-4333-8444-555555555555"
OWNER = 4242
DAY = datetime(2026, 10, 24, 5, 0, tzinfo=timezone.utc).timestamp()  # 10:30 IST
NIGHT = datetime(2026, 10, 24, 18, 0, tzinfo=timezone.utc).timestamp()  # 23:30 IST
LATE = datetime(2026, 10, 24, 17, 30, tzinfo=timezone.utc).timestamp()  # 23:00 IST
MORNING = datetime(2026, 10, 25, 2, 30, tzinfo=timezone.utc).timestamp()  # 08:00 IST, before the pool closes (10:30 IST)
TENANT = "0190a5b2-aaaa-4222-8333-444455556666"
KEY = "ballot_key_box"
#: The control plane's routes (index.js: POST /tenants/:id/godconst/ballot[/rate|/submit]) and each op's exact body
#: (godconst-ballot.js parseBody: read `{}`, rate exactly three keys, submit exactly `{pool_sha256}`; else 400).
CP_ROUTES = {f"/tenants/{TENANT}/godconst/ballot": "read", f"/tenants/{TENANT}/godconst/ballot/rate": "rate",
             f"/tenants/{TENANT}/godconst/ballot/submit": "submit"}
CP_BODY_KEYS = {"read": set(), "rate": {"pool_sha256", "statement_id", "rating"}, "submit": {"pool_sha256"}}
SESSION_KEYS = {"pool_id", "pool_sha256", "order_rule", "nonce", "order", "closes_at", "status", "started_at",
                "header_message_id", "page", "cards", "rated", "final_sent", "send_failures"}


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
        return [m for m in self.sent if m.reply_markup and m.reply_markup.inline_keyboard[0][0].callback_data.startswith("gcb:r:")]


class Server:
    """The control plane and the app behind it: one resident's ballot, merged per statement. Called as the plugin's
    `caller`/`reader`, it runs the plugin's real `cp_call`; the request reaches `answer` through a fake opener (or a
    loopback server), which routes on the PATH as the real control plane does."""

    def __init__(self, plugin, n=6, fake_opener=True):
        self.P = plugin
        self.state = "open"
        self.order = [f"s{i:03d}" for i in range(1, n + 1)]
        self.ratings = {}
        self.calls = []
        self.refuse = None
        # The box's wiring as the control plane writes it ($HERMES_HOME/.env; the process env stays clean).
        with open(os.path.join(os.environ["HERMES_HOME"], ".env"), "w", encoding="utf-8") as handle:
            handle.write(f"CONTROL_PLANE_URL=http://127.0.0.1:9\nAV_GODCONST_BALLOT_KEY={KEY}\n")
        if fake_opener:
            plugin._OPENER = FakeOpener(self)

    def view(self):
        return {
            "state": self.state,
            "pool": {"id": POOL, "sha256": SHA, "rating_closes_at": "2026-10-25T05:00:00.000Z", "n_statements": len(self.order), "order_rule": "godconst-order-v2"},
            "categories": [{"id": "care", "label": "Care"}],
            "statements": [{"id": sid, "category": "care", "text": f"{TEXT} {sid}", "author_type": "odin"} for sid in self.order] if self.state == "open" else [],
            "ratings": dict(self.ratings),
            "revision": len(self.ratings),
        }

    def __call__(self, op, body, home=None):
        return self.P.cp_call(op, body, home)

    def answer(self, path, body):
        """`(status, payload)` for one POST. The route is the PATH (index.js), the body is the op's exact keys
        (parseBody), as the real control plane; `calls` records (the routed op, the body)."""
        op = CP_ROUTES.get(path)
        self.calls.append((op or path, dict(body)))
        if op is None:
            return 404, {"error": "not_found"}
        if set(body) != CP_BODY_KEYS[op]:
            return 400, {"error": "body_invalid"}
        if self.refuse:
            return self.refuse[0], {"error": self.refuse[1]}
        if op == "read":
            return 200, self.view()
        if op == "submit":
            if not self.ratings:
                return 422, {"error": "incomplete"}
            self.state = "submitted"
            return 200, {"state": "submitted", "revision": 10, "n_rated": len(self.ratings), "n_statements": len(self.order), "progress": {}}
        if self.state == "submitted":
            return 409, {"error": "submitted"}
        assert body["pool_sha256"] == SHA
        self.ratings[body["statement_id"]] = body["rating"]
        return 200, {"state": "saved", "unchanged": False, "revision": 9, "ratings": dict(self.ratings),
                     "progress": {"answered": len(self.ratings), "total": len(self.order), "missing": 0}}


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
    """Stands in for the plugin's urllib opener: the request `cp_call` built goes to `Server.answer` by its path."""

    def __init__(self, server):
        self.server = server

    def open(self, request, timeout=None):
        assert request.get_method() == "POST" and request.get_header("Authorization") == f"Bearer {KEY}"
        status, payload = self.server.answer(urllib.parse.urlsplit(request.full_url).path, json.loads(request.data))
        raw = json.dumps(payload).encode()
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, "refused", email.message.Message(), io.BytesIO(raw))
        return _Response(status, raw)


class LoopbackCP:
    """The control plane on a loopback port (real HTTP): routes by path through `Server.answer`; `seen` keeps
    (path, Authorization, raw body)."""

    def __init__(self, server):
        seen = self.seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                seen.append((self.path, self.headers["Authorization"], raw))
                status, payload = server.answer(self.path, json.loads(raw))
                out = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def log_message(self, *args):
                pass

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.httpd.server_port}"

    def __enter__(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        return False


class GatedBot(Bot):
    """A bot whose `hold`-th send waits on `gate`: a pass caught mid-send while the resident taps."""

    def __init__(self, hold):
        super().__init__()
        self.hold, self.n, self.gate = hold, 0, None

    async def send_message(self, **kw):
        self.n += 1
        if self.n == self.hold:
            await self.gate.wait()
        return await super().send_message(**kw)


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


def tap(P, bot, server, msg, value, *, user=OWNER, data=None, clock=DAY):
    position_data = data or msg.reply_markup.inline_keyboard[0][value - 1].callback_data
    q = Query(position_data, msg, user=user)
    handler = P.make_handler(None, make_button=make_button, make_markup=make_markup, caller=server, clock=lambda: clock)
    run(handler(type("Update", (), {"callback_query": q})()))
    return q


def start(P, bot, server, now=DAY):
    P._last_read["at"] = 0.0
    return run(P.pass_once(bot, None, make_button, make_markup, now=now, reader=server))


def ledger_text(home):
    with open(os.path.join(home, "av-godconst", "ballot.json"), encoding="utf-8") as handle:
        return handle.read()


def assert_no_value_on_disk(home):
    """N3: the ledger holds ids, positions and message ids only (the session's fixed keys; a card is exactly its
    message id and its Submit flag); the tombstone is exactly {pool_sha256, nonce, status, at}; the marker is empty.
    No rating value, text or derivative can sit in any of them."""
    raw = ledger_text(home)
    assert TEXT not in raw and "ratings" not in raw
    stored = json.loads(raw)
    assert set(stored) <= {"v", "session", "ended"} and stored["v"] == 1
    session = stored["session"]
    if session is not None:
        assert set(session) == SESSION_KEYS
        assert all(isinstance(sid, str) for sid in session["order"])
        assert all(type(p) is int for p in session["rated"])
        for position, card in session["cards"].items():
            assert position.isdigit() and set(card) == {"message_id", "submit"}
            assert type(card["message_id"]) is int and type(card["submit"]) is bool
    if "ended" in stored:
        assert set(stored["ended"]) == {"pool_sha256", "nonce", "status", "at"}
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    assert not os.path.exists(marker) or os.path.getsize(marker) == 0


# --------------------------------------------------------------------------- pure logic


def test_callback_data_round_trip_bounds_and_refusals(plugin):
    L = plugin.L
    assert L.parse_callback(L.rating_callback("AbCd_-12", 29, 5)) == ("rate", "AbCd_-12", 29, 5)
    assert L.parse_callback("gcb:x:AbCd_-12") == ("stop", "AbCd_-12")
    assert L.parse_callback("gcb:g:AbCd_-12") == ("resume", "AbCd_-12")
    assert len(L.rating_callback("AbCd_-12", 499, 5).encode()) <= 64
    for bad in ("gcb:r:AbCd_-12:1:6", "gcb:r:AbCd_-12:01:3", "gcb:r:short:1:3", "gcb:r:AbCd_-12:1000:3", "avr:f:1:x", None, 7, "gcb:z:AbCd_-12", "gcb:" + "x" * 70):
        assert L.parse_callback(bad) is None


def test_pages_are_pairs_and_skip_what_the_web_page_rated(plugin):
    L = plugin.L
    assert L.PAGE_SIZE == 2
    assert [L.page_positions(p, 5) for p in range(3)] == [[0, 1], [2, 3], [4]]
    assert L.next_page(-1, 6, set()) == 0
    assert L.next_page(0, 6, {0, 1, 2, 3}) == 2
    assert L.next_page(0, 6, {0, 1, 2, 3, 4, 5}) is None
    assert L.page_done(-1, 6, set()) and not L.page_done(0, 6, {0}) and L.page_done(0, 6, {0, 1})
    assert L.to_send(1, 6, {2}, ["0", "1"]) == [3]


def test_view_shape_is_checked_and_authorship_never_kept(plugin):
    server = Server(plugin)
    view = plugin.L.valid_view(server.view())
    assert view["statements"][0] == {"id": "s001", "category": "care", "text": f"{TEXT} s001"}
    assert view["pool"]["order_rule"] == "godconst-order-v2"
    for broken in ({"state": "maybe"}, {**server.view(), "ratings": {"s001": 6}}, {**server.view(), "pool": {"id": "x", "sha256": SHA}},
                   {**server.view(), "statements": []}, {**server.view(), "statements": [{"id": "s001", "category": "care", "text": ""}]}):
        assert plugin.L.valid_view(broken) is None
    assert plugin.L.valid_view({"state": "no_pool", "ratings": {}})["state"] == "no_pool"


# --------------------------------------------------------------------------- start


def test_start_sends_the_header_and_the_first_pair_and_keeps_no_text_or_value(plugin, home):
    bot, server = Bot(), Server(plugin)
    assert start(plugin, bot, server) == "open"
    header, *cards = bot.sent
    assert "Village constitution: 6 statements to rate" in header.text
    assert "5  Strongly support inclusion" in header.text and "Open until 10:30 IST, Sun 25 Oct." in header.text
    assert [b.text for b in header.reply_markup.inline_keyboard[0]] == ["Submit my ratings", "Stop these cards"]
    assert [c.text.splitlines()[0] for c in cards] == ["Statement 1 of 6 · Care", "Statement 2 of 6 · Care"]
    assert f"{TEXT} s001" in cards[0].text and "odin" not in cards[0].text.lower()
    assert [b.text for b in cards[0].reply_markup.inline_keyboard[0]] == ["1", "2", "3", "4", "5"]
    # The last card of each page carries Submit on a second row.
    assert len(cards[0].reply_markup.inline_keyboard) == 1 and cards[1].reply_markup.inline_keyboard[1][0].text == "Submit my ratings"
    stored = ledger_text(home)
    assert TEXT not in stored and '"ratings"' not in stored and "mark" not in stored
    assert sorted(os.listdir(os.path.join(home, "av-godconst"))) == ["ballot.json"]  # no key on disk
    assert oct(os.stat(os.path.join(home, "av-godconst", "ballot.json")).st_mode & 0o777) == "0o600"
    # A second pass before it is due reads nothing; when due, nothing new is sent while the pair is unrated.
    assert run(plugin.pass_once(bot, None, make_button, make_markup, now=DAY + 10, reader=server)) == "not_due"
    assert start(plugin, bot, server, now=DAY + 400) == "open"
    assert len(bot.sent) == 3


def test_no_first_card_at_night_off_or_not_open(plugin, home, monkeypatch):
    bot, server = Bot(), Server(plugin)
    assert start(plugin, bot, server, now=NIGHT) == "open"
    assert bot.sent == []
    for state in ("no_pool", "not_participant", "closed"):
        server.state = state
        assert start(plugin, bot, server) == state
    assert bot.sent == []
    monkeypatch.setenv("AV_GODCONST_BALLOT", "0")
    assert start(plugin, bot, server) == "off"
    assert server.calls[-1] == ("read", {})  # the last read was before the switch went off


def test_all_rated_on_the_web_already_sends_nothing(plugin, home):
    bot, server = Bot(), Server(plugin, n=2)
    server.ratings = {"s001": 3, "s002": 4}
    start(plugin, bot, server)
    assert bot.sent == []
    assert json.loads(ledger_text(home))["session"]["status"] == "done"


# --------------------------------------------------------------------------- taps


def test_a_rated_pair_brings_the_next_pair_and_a_retap_is_a_revision(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    first, second = bot.cards()
    q = tap(plugin, bot, server, first, 4)
    assert q.answers == ["Saved: Support inclusion"]
    assert [b.text for b in q.edited[0].inline_keyboard[0]] == ["1", "2", "3", "✅ 4", "5"]
    assert server.ratings == {"s001": 4}
    assert len(bot.cards()) == 2
    tap(plugin, bot, server, second, 1)
    assert [c.text.splitlines()[0] for c in bot.cards()[2:]] == ["Statement 3 of 6 · Care", "Statement 4 of 6 · Care"]
    q = tap(plugin, bot, server, first, 2)
    assert q.answers == ["Saved: Oppose inclusion (changed)"]
    assert server.ratings["s001"] == 2 and len(bot.cards()) == 4
    assert ("rate", {"pool_sha256": SHA, "statement_id": "s001", "rating": 2}) in server.calls
    assert_no_value_on_disk(home)


def test_the_last_pair_ends_with_one_line(plugin, home):
    bot, server = Bot(), Server(plugin, n=4)
    start(plugin, bot, server)
    for value, card in zip((5, 4), bot.cards()):
        tap(plugin, bot, server, card, value)
    for value, card in zip((3, 1), bot.cards()[2:]):
        tap(plugin, bot, server, card, value)
    assert bot.sent[-1].text.startswith("All 4 statements rated. Thank you.")
    assert bot.sent[-1].reply_markup.inline_keyboard[0][0].text == "Submit my ratings"
    tap(plugin, bot, server, bot.cards()[0], 2)
    assert sum("statements rated" in m.text for m in bot.sent) == 1
    assert json.loads(ledger_text(home))["session"]["status"] == "done"
    assert_no_value_on_disk(home)


def test_a_pair_rated_on_the_web_is_skipped_and_web_changes_re_mark_cards(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    server.ratings.update({"s003": 2, "s004": 5})  # the web page rated pair 2
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    tap(plugin, bot, server, second, 4)
    assert [c.text.splitlines()[0] for c in bot.cards()[2:]] == ["Statement 5 of 6 · Care", "Statement 6 of 6 · Care"]
    server.ratings["s001"] = 1  # changed on the web page
    start(plugin, bot, server, now=DAY + 1000)
    message_id, markup = [e for e in bot.edits if e[0] == first.message_id][-1]
    assert [b.text for b in markup.inline_keyboard[0]] == ["✅ 1", "2", "3", "4", "5"]
    # After a restart (memory gone) every sent card is redrawn from the app, the Submit row kept.
    plugin._SHOWN.clear()
    before = len(bot.edits)
    start(plugin, bot, server, now=DAY + 2000)
    redrawn = {e[0]: e[1] for e in bot.edits[before:]}
    assert len(redrawn) == 4 and [b.text for b in redrawn[second.message_id].inline_keyboard[0]][3] == "✅ 4"
    assert redrawn[second.message_id].inline_keyboard[1][0].text == "Submit my ratings"


def test_only_the_owner_in_their_own_dm(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    card = bot.cards()[0]
    calls = len(server.calls)
    assert tap(plugin, bot, server, card, 3, user=999).answers == ["This card is not yours"]
    q = Query(card.reply_markup.inline_keyboard[0][2].callback_data, card)
    card.chat.type = "group"
    run(plugin.make_handler(None, make_button=make_button, make_markup=make_markup, caller=server)(type("U", (), {"callback_query": q})()))
    assert q.answers == ["This card is not yours"]
    assert len(server.calls) == calls


def test_old_cards_bad_buttons_and_refusals(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    card = bot.cards()[0]
    assert tap(plugin, bot, server, card, 3, data="gcb:r:ZZZZZZZZ:0:3").answers == ["This card is from an earlier ballot."]
    assert tap(plugin, bot, server, card, 3, data="gcb:r:nonsense").answers == ["This button is not valid."]
    server.refuse = (403, "not_enabled")
    assert tap(plugin, bot, server, card, 3).answers == ["Rating by Telegram is off right now. You can still rate on the Constitution page."]
    assert json.loads(ledger_text(home))["session"] is not None  # a switch is not an ending
    server.refuse = (409, "submitted")
    assert tap(plugin, bot, server, card, 3).answers == ["Your ballot is submitted, so rating is closed for you."]
    stored = json.loads(ledger_text(home))
    assert stored["session"] is None and stored["ended"]["status"] == "submitted" and set(stored["ended"]) == {"pool_sha256", "nonce", "status", "at"}
    assert_no_value_on_disk(home)
    server.refuse = None
    assert tap(plugin, bot, server, card, 4).answers == ["Your ballot is submitted, so rating is closed for you."]


def test_withdrawal_and_close_settle_the_session_without_a_message(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    sent = len(bot.sent)
    server.refuse = (403, "consent_withdrawn")
    assert start(plugin, bot, server, now=DAY + 400) == "consent_withdrawn"
    assert json.loads(ledger_text(home))["ended"]["status"] == "withdrawn"
    plugin.save_ledger({"v": 1, "session": None})
    server.refuse = None
    start(plugin, bot, server)
    server.state = "closed"
    start(plugin, bot, server, now=DAY + 1000)
    stored = json.loads(ledger_text(home))
    assert stored["session"] is None and stored["ended"]["status"] == "closed"
    assert len(bot.sent) == sent + 3  # the restart's header and pair only
    # The pool reopening (or a stale read) never restarts a ballot that ended on this box.
    server.state = "open"
    start(plugin, bot, server, now=DAY + 2000)
    assert len(bot.sent) == sent + 3


def test_stop_and_resume(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    header = bot.sent[0]
    q = tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    assert q.answers == ["Stopped. Your ratings are kept."]
    assert q.edited[0].inline_keyboard[0][1].text == "Resume these cards"
    assert bot.sent[-1].text.startswith("Stopped: no more statement cards.")
    for card, value in zip(bot.cards(), (2, 3)):
        tap(plugin, bot, server, card, value)
    assert len(bot.cards()) == 2 and server.ratings == {"s001": 2, "s002": 3}
    assert_no_value_on_disk(home)
    tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    start(plugin, bot, server, now=DAY + 2000)
    assert len(bot.cards()) == 4
    assert_no_value_on_disk(home)


def test_a_blocked_bot_retries_then_gives_up(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    bot.fail = 10
    tap(plugin, bot, server, second, 4)
    for i in range(3):
        start(plugin, bot, server, now=DAY + 1000 * (i + 1))
    assert json.loads(ledger_text(home))["session"]["status"] == "undeliverable"


def test_logs_carry_codes_never_text_values_or_ids(plugin, home, caplog):
    caplog.set_level(logging.INFO)
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    for card, value in zip(bot.cards(), (4, 5)):
        tap(plugin, bot, server, card, value)
    lines = "\n".join(r.getMessage() for r in caplog.records)
    assert "outcome=saved" in lines and "outcome=sync" in lines
    for secret in (TEXT, "s001", "Support", str(OWNER), "0190a5b2-aaaa", "gcb:"):
        assert secret not in lines


# --------------------------------------------------------------------------- the wire


def test_cp_origin_is_pinned(plugin):
    assert plugin.cp_origin("https://control-plane-production-606c.up.railway.app") == "https://control-plane-production-606c.up.railway.app"
    for bad in ("https://evil.example", "http://control-plane-production-606c.up.railway.app", "https://control-plane-production-606c.up.railway.app/x",
                "https://u:p@control-plane-production-606c.up.railway.app", "https://control-plane-production-606c.up.railway.app:8443", ""):
        assert plugin.cp_origin(bad) is None
    assert plugin.cp_origin("http://127.0.0.1:9") == "http://127.0.0.1:9"


def test_cp_call_posts_the_box_key_to_its_own_tenant(plugin, home, monkeypatch):
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = self.rfile.read(int(self.headers["Content-Length"]))
            seen.append((self.path, self.headers["Authorization"], json.loads(body)))
            status, payload = (200, {"state": "saved", "ratings": {}}) if self.path.endswith("/rate") else (409, {"error": "stale_pool"})
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert plugin.cp_call("read", {}).code == "not_configured"
        monkeypatch.setenv("CONTROL_PLANE_URL", f"http://127.0.0.1:{server.server_port}")
        monkeypatch.setenv("AV_GODCONST_BALLOT_KEY", "ballot_key_box")
        monkeypatch.setenv("EDGEOS_API_KEY", "eos_live_box_key")
        rate = plugin.cp_call("rate", {"pool_sha256": SHA, "statement_id": "s001", "rating": 3})
        read = plugin.cp_call("read", {})
    finally:
        server.shutdown()
    assert (rate.status, rate.code, rate.ok) == (200, "saved", True)
    assert (read.status, read.code, read.ok) == (409, "stale_pool", False)
    tenant = "0190a5b2-aaaa-4222-8333-444455556666"
    assert seen == [
        (f"/tenants/{tenant}/godconst/ballot/rate", "Bearer ballot_key_box", {"pool_sha256": SHA, "statement_id": "s001", "rating": 3}),
        (f"/tenants/{tenant}/godconst/ballot", "Bearer ballot_key_box", {}),
    ]


def test_register_wires_one_platform_handler(plugin):
    wired = []
    plugin.register(type("Ctx", (), {"register_platform_handler": lambda self, platform, factory: wired.append((platform, factory))})())
    assert [w[0] for w in wired] == ["telegram"]


def test_submit_asks_then_submits_the_merged_draft_and_forgets_the_ballot(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    first, second = bot.cards()
    submit_data = second.reply_markup.inline_keyboard[1][0].callback_data
    server.ratings["s005"] = 2  # rated on the web page: the box re-reads, so the count is the app's
    assert tap(plugin, bot, server, second, 1, data=submit_data).answers == ["Confirm below."]
    confirm = bot.sent[-1]
    assert confirm.text.startswith("Submit your ratings now? You rated 1 of 6")
    server.ratings.clear()
    yes, no = confirm.reply_markup.inline_keyboard[0]
    assert tap(plugin, bot, server, confirm, 1, data=yes.callback_data).answers == ["Rate at least one statement before you submit."]
    assert tap(plugin, bot, server, confirm, 1, data=no.callback_data).answers == ["Not submitted. You can keep rating."]
    tap(plugin, bot, server, first, 4)
    q = tap(plugin, bot, server, confirm, 1, data=yes.callback_data)
    assert q.answers == ["Submitted"] and q.edited == [None]
    assert bot.sent[-1].text == "Submitted: 1 of 6 rated. Thank you: your ratings are final."
    assert ("submit", {"pool_sha256": SHA}) in server.calls
    stored = json.loads(ledger_text(home))
    assert stored["session"] is None and stored["ended"]["status"] == "submitted"
    assert "s001" not in ledger_text(home)
    assert_no_value_on_disk(home)
    calls = len(server.calls)
    assert tap(plugin, bot, server, second, 5).answers == ["Your ballot is submitted, so rating is closed for you."]
    assert len(server.calls) == calls


def test_the_window_closing_forgets_the_ballot(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    card = bot.cards()[0]
    after = datetime(2026, 10, 25, 5, 1, tzinfo=timezone.utc).timestamp()
    assert tap(plugin, bot, server, card, 3, clock=after).answers == ["Rating has closed."]
    assert json.loads(ledger_text(home))["ended"]["status"] == "closed"
    assert all(op != "rate" for op, _ in server.calls)
    plugin.save_ledger({"v": 1, "session": None})
    start(plugin, bot, server)
    assert run(plugin.pass_once(bot, None, make_button, make_markup, now=after, reader=server)) == "window_over"
    assert json.loads(ledger_text(home))["session"] is None


def test_an_app_404_on_save_ends_the_ballot_as_withdrawn(plugin, home):
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    server.refuse = (404, "not_found")
    assert tap(plugin, bot, server, bot.cards()[0], 3).answers == ["You can't take part right now."]
    assert json.loads(ledger_text(home))["ended"]["status"] == "withdrawn"


def test_the_page_open_marker_follows_the_open_page(plugin, home):
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    bot, server = Bot(), Server(plugin, n=4)
    start(plugin, bot, server)
    assert os.path.isfile(marker) and os.path.getsize(marker) == 0 and oct(os.stat(marker).st_mode & 0o777) == "0o600"
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    assert os.path.exists(marker)  # one card of the pair still unrated
    server.ratings["s002"] = 3  # rated on the web: the next read sees the page complete, then sends the next pair
    start(plugin, bot, server, now=DAY + 400)
    assert len(bot.cards()) == 4 and os.path.exists(marker)
    # Stop: the resident asked for no more cards, so the opener is not held.
    header = bot.sent[0]
    tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    assert not os.path.exists(marker)
    tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    assert os.path.exists(marker)
    # A complete page removes it (here the last pair: the final line follows, no new page).
    third, fourth = bot.cards()[2:]
    tap(plugin, bot, server, third, 2)
    assert os.path.exists(marker)
    tap(plugin, bot, server, fourth, 2)
    assert not os.path.exists(marker)
    assert bot.sent[-1].text.startswith("All 4 statements rated.")


def test_the_marker_goes_on_submit_window_close_and_withdrawal(plugin, home):
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    for ending in ("submit", "window", "withdrawal"):
        plugin.save_ledger({"v": 1, "session": None})
        bot, server = Bot(), Server(plugin)
        start(plugin, bot, server)
        assert os.path.exists(marker), ending
        first, second = bot.cards()
        if ending == "submit":
            tap(plugin, bot, server, first, 4)
            submit = second.reply_markup.inline_keyboard[1][0].callback_data
            tap(plugin, bot, server, second, 1, data=submit)
            yes = bot.sent[-1].reply_markup.inline_keyboard[0][0].callback_data
            tap(plugin, bot, server, bot.sent[-1], 1, data=yes)
        elif ending == "window":
            after = datetime(2026, 10, 25, 5, 1, tzinfo=timezone.utc).timestamp()
            assert run(plugin.pass_once(bot, None, make_button, make_markup, now=after, reader=server)) == "window_over"
        else:
            server.refuse = (403, "consent_withdrawn")
            tap(plugin, bot, server, first, 4)
        assert not os.path.exists(marker), ending


def test_each_page_touches_the_marker_and_start_up_removes_a_stale_one(plugin, home):
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    os.utime(marker, (1, 1))
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    tap(plugin, bot, server, second, 4)  # the next pair goes out: the marker is touched
    assert os.stat(marker).st_mtime > 1000
    # Start-up: an open page inside the window keeps it ...
    assert plugin.reconcile_page_open(now=DAY + 100) is True and os.path.exists(marker)
    # ... the window over, no session, or an unreadable ledger removes it.
    after = datetime(2026, 10, 25, 5, 1, tzinfo=timezone.utc).timestamp()
    assert plugin.reconcile_page_open(now=after) is False and not os.path.exists(marker)
    plugin.set_page_open(True)
    plugin.save_ledger({"v": 1, "session": None})
    plugin.register(type("Ctx", (), {"register_platform_handler": lambda self, platform, factory: None})())
    assert not os.path.exists(marker)
    plugin.set_page_open(True)
    os.chmod(plugin.ledger_path(), 0o644)
    assert plugin.reconcile_page_open(now=DAY) is False and not os.path.exists(marker)


# --------------------------------------------------------------------------- ov#483 fix-forward (review-b M1, S1, N2)


def test_each_op_posts_to_its_own_cp_route_and_an_unknown_op_never_falls_back(plugin, home):
    """M1: an explicit op -> path map; Submit goes to the cp's submit route, and an unknown op raises before any call
    (never the rate route)."""
    server = Server(plugin)
    assert plugin.OP_PATHS == {"read": "/tenants/{tenant}/godconst/ballot", "rate": "/tenants/{tenant}/godconst/ballot/rate",
                               "submit": "/tenants/{tenant}/godconst/ballot/submit",
                               "elicit_read": "/tenants/{tenant}/godconst/elicitation-cards",
                               "elicit_rate": "/tenants/{tenant}/godconst/elicitation-ratings"}
    server.ratings["s001"] = 3
    assert server("read", {}).code == "open"
    assert server("submit", {"pool_sha256": SHA}).code == "submitted"
    assert [op for op, _ in server.calls] == ["read", "submit"]
    for bad in ("bogus", "Submit", "rate ", ""):
        with pytest.raises(ValueError):
            plugin.cp_call(bad, {"pool_sha256": SHA})
    assert len(server.calls) == 2


def test_telegram_submit_reaches_the_cp_submit_route_over_the_wire(plugin, home, monkeypatch):
    """M1 / review-b P1 flipped: "Yes, submit" POSTs exactly {pool_sha256} to /ballot/submit (real HTTP, a loopback
    control plane that routes by path) and the final line carries the reply's n_rated. At cce708cb it went to
    /ballot/rate, the cp answered 400 body_invalid and the resident saw "Could not save that."."""
    server = Server(plugin, fake_opener=False)
    with LoopbackCP(server) as cp:
        monkeypatch.setenv("CONTROL_PLANE_URL", cp.origin)
        bot = Bot()
        assert start(plugin, bot, server) == "open"
        first, second = bot.cards()
        assert tap(plugin, bot, server, first, 4).answers == ["Saved: Support inclusion"]
        server.ratings["s005"] = 2  # rated on the web page: the final line counts the app's n_rated, not the box's
        assert tap(plugin, bot, server, second, 1, data=second.reply_markup.inline_keyboard[1][0].callback_data).answers == ["Confirm below."]
        confirm = bot.sent[-1]
        q = tap(plugin, bot, server, confirm, 1, data=confirm.reply_markup.inline_keyboard[0][0].callback_data)
    assert q.answers == ["Submitted"] and q.edited == [None]
    assert bot.sent[-1].text == "Submitted: 2 of 6 rated. Thank you: your ratings are final."
    submit_path = f"/tenants/{TENANT}/godconst/ballot/submit"
    assert [entry for entry in cp.seen if entry[0] == submit_path] == [
        (submit_path, f"Bearer {KEY}", json.dumps({"pool_sha256": SHA}, separators=(",", ":")).encode())]
    assert [path.rsplit("/", 1)[-1] for path, _, _ in cp.seen] == ["ballot", "rate", "ballot", "submit"]
    stored = json.loads(ledger_text(home))
    assert stored["session"] is None and stored["ended"]["status"] == "submitted"
    assert_no_value_on_disk(home)


def _pass_caught_mid_send(plugin, server, bot, taps):
    """Run one pass whose first card send (after the header is stored) waits; `taps(handler, bot)` taps meanwhile; then
    the send is released and the pass finishes. Returns what the taps returned."""

    async def scenario():
        bot.gate = asyncio.Event()
        plugin._last_read["at"] = 0.0
        task = asyncio.create_task(plugin.pass_once(bot, None, make_button, make_markup, now=DAY, reader=server))
        for _ in range(500):
            await asyncio.sleep(0.01)
            if bot.n >= bot.hold:
                break
        assert bot.n >= bot.hold and not task.done()
        handler = plugin.make_handler(None, make_button=make_button, make_markup=make_markup, caller=server, clock=lambda: DAY)
        out = await taps(handler, bot)
        bot.gate.set()
        assert await task == "open"
        return out

    return asyncio.run(scenario())


async def _tap_now(handler, message, data):
    q = Query(data, message)
    await handler(type("Update", (), {"callback_query": q})())
    return q.answers


def test_a_stop_tapped_while_a_pass_sends_stays_stopped(plugin, home):
    """S1 / review-b P4: the pass's write-back never undoes a Stop made during its sends; no next pair follows."""
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    server, bot = Server(plugin), GatedBot(hold=2)

    async def stop(handler, bot):
        header = bot.sent[0]
        answers = await _tap_now(handler, header, header.reply_markup.inline_keyboard[0][1].callback_data)
        return answers, json.loads(ledger_text(home))["session"]["status"]

    answers, mid = _pass_caught_mid_send(plugin, server, bot, stop)
    assert answers == ["Stopped. Your ratings are kept."] and mid == "stopped"
    assert json.loads(ledger_text(home))["session"]["status"] == "stopped"  # at cce708cb: "active" again
    assert not os.path.exists(marker)
    first, second = bot.cards()
    tap(plugin, bot, server, first, 2)
    tap(plugin, bot, server, second, 2)
    start(plugin, bot, server, now=DAY + 400)
    assert len(bot.cards()) == 2  # nothing after "Stopped"
    assert json.loads(ledger_text(home))["session"]["status"] == "stopped"
    assert_no_value_on_disk(home)


def test_a_submit_while_a_pass_sends_stays_ended(plugin, home):
    """S1: a session Submit ends during a pass's sends: the pass never brings the session (or the marker) back."""
    marker = os.path.join(home, "av-events", "godconst", "page-open")
    server, bot = Server(plugin), GatedBot(hold=2)
    server.ratings["s006"] = 3  # one rating on the web page, so the ballot can be submitted

    async def submit(handler, bot):
        header = bot.sent[0]
        asked = await _tap_now(handler, header, header.reply_markup.inline_keyboard[0][0].callback_data)
        confirm = bot.sent[-1]
        done = await _tap_now(handler, confirm, confirm.reply_markup.inline_keyboard[0][0].callback_data)
        return asked, done

    asked, done = _pass_caught_mid_send(plugin, server, bot, submit)
    assert (asked, done) == (["Confirm below."], ["Submitted"])
    stored = json.loads(ledger_text(home))
    assert stored["session"] is None and stored["ended"]["status"] == "submitted"  # at cce708cb: the session is back
    assert not os.path.exists(marker)
    calls, sent = len(server.calls), len(bot.sent)
    assert tap(plugin, bot, server, bot.cards()[0], 4).answers == ["Your ballot is submitted, so rating is closed for you."]
    assert len(server.calls) == calls
    start(plugin, bot, server, now=DAY + 400)
    assert len(bot.sent) == sent
    assert_no_value_on_disk(home)


def test_a_night_tick_holds_the_next_pair_but_a_tap_is_answered_at_once(plugin, home):
    """N2: a pass (a tick) sends nothing outside 08:00-21:30 IST, not only the first card; the resident's own tap at
    night still gets its next pair at once."""
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    first, second = bot.cards()
    # 23:00 IST: the resident rates the pair by taps: the reply (the next pair) goes at once.
    tap(plugin, bot, server, first, 4, clock=LATE)
    tap(plugin, bot, server, second, 5, clock=LATE)
    assert [c.text.splitlines()[0] for c in bot.cards()[2:]] == ["Statement 3 of 6 · Care", "Statement 4 of 6 · Care"]
    # The next pair is finished on the web page: a night tick holds the following pair ...
    server.ratings.update({"s003": 2, "s004": 3})
    sent = len(bot.sent)
    assert start(plugin, bot, server, now=LATE + 600) == "open"
    assert start(plugin, bot, server, now=LATE + 1800) == "open"
    assert len(bot.sent) == sent
    # ... and the first in-window tick sends it.
    assert start(plugin, bot, server, now=MORNING) == "open"
    assert [c.text.splitlines()[0] for c in bot.cards()[4:]] == ["Statement 5 of 6 · Care", "Statement 6 of 6 · Care"]


def test_a_night_tick_holds_the_final_line_a_retry_and_a_resume(plugin, home):
    """N2: the final line, a failed card's retry and the cards after a Resume are tick sends: daytime only."""
    # The final line (the last pair rated on the web page).
    bot, server = Bot(), Server(plugin, n=2)
    start(plugin, bot, server)
    server.ratings.update({"s001": 1, "s002": 2})
    sent = len(bot.sent)
    start(plugin, bot, server, now=LATE)
    assert len(bot.sent) == sent
    start(plugin, bot, server, now=MORNING)
    assert bot.sent[-1].text.startswith("All 2 statements rated.")
    # A failed card's retry.
    plugin.save_ledger({"v": 1, "session": None})
    bot, server = Bot(), Server(plugin, n=4)
    start(plugin, bot, server)
    first, second = bot.cards()
    tap(plugin, bot, server, first, 4)
    bot.fail = 1
    tap(plugin, bot, server, second, 4)  # the next pair's send fails
    assert len(bot.cards()) == 2
    start(plugin, bot, server, now=LATE)
    assert len(bot.cards()) == 2
    start(plugin, bot, server, now=MORNING)
    assert [c.text.splitlines()[0] for c in bot.cards()[2:]] == ["Statement 3 of 4 · Care", "Statement 4 of 4 · Care"]
    # A Resume at night: the cards wait for the morning.
    plugin.save_ledger({"v": 1, "session": None})
    bot, server = Bot(), Server(plugin)
    start(plugin, bot, server)
    header = bot.sent[0]
    tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data)
    for card, value in zip(bot.cards(), (2, 3)):
        tap(plugin, bot, server, card, value)
    assert len(bot.cards()) == 2
    q = tap(plugin, bot, server, header, 1, data=header.reply_markup.inline_keyboard[0][1].callback_data, clock=LATE)
    assert q.answers == ["Resumed. The next statements come shortly."]
    start(plugin, bot, server, now=LATE + 60)
    assert len(bot.cards()) == 2
    start(plugin, bot, server, now=MORNING)
    assert len(bot.cards()) == 4
