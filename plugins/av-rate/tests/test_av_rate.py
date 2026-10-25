"""av-rate: the suggestion rating cards' buttons, ledger, hand-off records and agent line."""

from __future__ import annotations

import asyncio
import json
import os
import types

import pytest

OWNER = "123456789"
OTHER = "987654321"
TENANT = "0b3c2a1f-aaaa-bbbb-cccc-1234567890ab"
OPP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
OPP2 = "1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
T0 = 1_760_000_000.0

CORE_CALLBACKS = ["ea:once:17", "cl:2:abc", "mp:anthropic", "cp:fast:on", "sc:yes:1", "gt:archive:1", "update_prompt:yes", "avv:0:" + "A" * 44]


# --------------------------------------------------------------------------- fakes


class Button:
    def __init__(self, text, callback_data=None, url=None):
        self.text, self.callback_data, self.url = text, callback_data, url


class Markup:
    def __init__(self, rows):
        self.inline_keyboard = rows


class Sent:
    def __init__(self, message_id):
        self.message_id = message_id


class Bot:
    def __init__(self, fail=0):
        self.sent: list[dict] = []
        self.fail = fail
        self._next = 100

    async def send_message(self, **kwargs):
        if self.fail:
            self.fail -= 1
            raise RuntimeError("telegram down")
        self.sent.append(kwargs)
        self._next += 1
        return Sent(self._next)


class Query:
    def __init__(self, data, bot, user=OWNER, chat=OWNER, rows=None, message_id=101):
        self.data = data
        self.from_user = types.SimpleNamespace(id=int(user))
        self.message = types.SimpleNamespace(chat=types.SimpleNamespace(id=int(chat)), message_id=message_id,
                                             reply_markup=Markup(rows) if rows is not None else None, get_bot=lambda: bot)
        self.answers: list[str] = []
        self.edits: list[object] = []

    async def answer(self, text=None, **_):
        self.answers.append(text)

    async def edit_message_reply_markup(self, reply_markup=None, **_):
        self.edits.append(reply_markup)


class Ctx:
    def __init__(self, accept=True, raises=False):
        self.calls: list[tuple[str, str]] = []
        self.accept, self.raises = accept, raises

    def inject_message(self, content, role="user", *, session_key=None):
        if self.raises:
            raise RuntimeError("no gateway")
        self.calls.append((content, session_key))
        return self.accept


def run(coro):
    return asyncio.run(coro)


def stage(home, plugin, opp=OPP, **over):
    folder = home / "av-events" / "proactive" / "rating"
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    data = {"v": 1, "opportunity_id": opp, "intention_id": None, "name": "Maya Rao", "headline": "Climate finance", "agent_name": "Edge",
            "staged_at": plugin.now_iso(T0 - 60), "date": "2026-10-21"}
    data.update(over)
    path = folder / f"stage-{opp}.json"
    path.write_text(json.dumps(data))
    os.chmod(path, 0o600)
    return path


def ledger(home):
    return json.loads((home / "av-events" / "proactive" / "rated.json").read_text())


def records(home):
    folder = home / "av-events" / "proactive" / "rating-events"
    out = []
    for name in sorted(os.listdir(folder)) if folder.exists() else []:
        out += json.loads((folder / name).read_text())["records"]
    return out


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setenv("AV_RATE_CARDS", "1")
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OWNER)
    monkeypatch.setenv("AV_TENANT_ID", TENANT)


def pickup(plugin, bot, ctx=None, now=T0):
    return run(plugin.pick_up(bot, None, lambda t, d: Button(t, callback_data=d), Markup, now=now, ctx=ctx))


def handler(plugin, ctx=None, now=T0):
    return plugin.make_handler(None, make_button=lambda t, d: Button(t, callback_data=d), make_markup=Markup, clock=lambda: now, ctx=ctx)


# --------------------------------------------------------------------------- callback data


def test_callback_data_shape_and_the_64_byte_limit(plugin):
    nonce = plugin.make_nonce(b"k" * 32, OPP)
    assert len(nonce) == 22
    for value in range(1, 6):
        data = plugin.fit_callback(value, nonce)
        assert len(data.encode("utf-8")) <= plugin.CALLBACK_DATA_MAX_BYTES
        assert plugin.parse_callback(data) == ("fit", str(value), nonce)
    assert plugin.parse_callback(plugin.planned_callback("y", nonce)) == ("planned", "y", nonce)
    assert plugin.parse_callback(plugin.planned_callback("n", nonce)) == ("planned", "n", nonce)
    assert len(plugin.planned_callback("n", nonce).encode("utf-8")) <= 64
    for choice in plugin.COLLAB_VALUES:
        data = plugin.collab_callback(choice, nonce)
        assert len(data.encode("utf-8")) <= plugin.CALLBACK_DATA_MAX_BYTES
        assert plugin.parse_callback(data) == ("collab", choice, nonce)


@pytest.mark.parametrize("data", [None, "", "avr:f:0:" + "a" * 22, "avr:f:6:" + "a" * 22, "avr:p:x:" + "a" * 22, "avr:c:x:" + "a" * 22, "avr:c:yes:" + "a" * 22, "avr:t:f:" + "a" * 22, "avr:f:3:" + "a" * 21, "avr:f:3:" + "a" * 23, "avr:f:3:" + "é" * 22, *CORE_CALLBACKS])
def test_parse_refuses_anything_else(plugin, data):
    assert plugin.parse_callback(data) is None


def test_nonce_is_keyed_and_stable(plugin):
    assert plugin.make_nonce(b"k" * 32, OPP) == plugin.make_nonce(b"k" * 32, OPP)
    assert plugin.make_nonce(b"k" * 32, OPP) != plugin.make_nonce(b"j" * 32, OPP)
    assert plugin.make_nonce(b"k" * 32, OPP) != plugin.make_nonce(b"k" * 32, OPP2)


def test_hash_key_prefers_av_events_key_then_makes_its_own(plugin, home):
    own = plugin.hash_key()
    assert own is not None and len(own) == 32
    key_file = home / "av-events" / "av-rate.key"
    assert key_file.exists() and (key_file.stat().st_mode & 0o777) == 0o600
    assert plugin.hash_key() == own
    (home / "av-events" / "hash.key").write_text("ab" * 32 + "\n")
    os.chmod(home / "av-events" / "hash.key", 0o600)
    assert plugin.hash_key() == bytes.fromhex("ab" * 32)


def test_a_key_file_that_is_not_private_is_never_used(plugin, home):
    """Review round 1: keys are read with the private-file checks (regular, this user, 0600)."""
    (home / "av-events" / "hash.key").write_text("ab" * 32 + "\n")  # 0644 by default
    own = plugin.hash_key()
    assert own is not None and own != bytes.fromhex("ab" * 32)
    os.chmod(home / "av-events" / "av-rate.key", 0o644)
    # Both keys unusable: None this pass (the pick-up counts no_key), never a silent new key.
    assert plugin.hash_key() is None


def test_an_empty_or_partial_key_file_is_not_yet_not_dead(plugin, home):
    """Review round 1: a reader that met a half-written key must not return None forever."""
    key_file = home / "av-events" / "av-rate.key"
    key_file.write_text("")
    os.chmod(key_file, 0o600)
    assert plugin.hash_key() is None
    key_file.write_text("cd" * 32 + "\n")
    assert plugin.hash_key() == bytes.fromhex("cd" * 32)


# --------------------------------------------------------------------------- card text and keyboards


def test_card_one_text_labels_privacy_and_manage_line(plugin):
    text = plugin.fit_text("Edge", "Maya <Rao>", "Climate & finance")
    assert text.startswith("How good a match was this suggestion from Edge?\nMaya &lt;Rao&gt;, about Climate &amp; finance\n")
    for value, label in plugin.LABELS.items():
        assert f"{plugin.EMOJI[value]}  {label}" in text
    assert "\n\nMaya &lt;Rao&gt; never sees this.\n\n" in text
    assert "research team" not in text
    assert text.endswith("\n\n" + plugin.MANAGE_LINE)
    assert "about" not in plugin.fit_text("Edge", "Maya", None).splitlines()[1]


def test_keyboards_emoji_row_and_collab_yes_no_not_sure(plugin):
    rows = plugin.fit_rows("n" * 22, lambda t, d: Button(t, callback_data=d))
    assert len(rows) == 1 and [b.text for b in rows[0]] == ["😕", "😐", "🙂", "😊", "🤩"]
    rows = plugin.collab_rows("n" * 22, lambda t, d: Button(t, callback_data=d))
    assert [[b.text for b in row] for row in rows] == [["Yes", "No"], ["Not sure yet"]]
    assert [b.callback_data for row in rows for b in row] == [plugin.collab_callback(c, "n" * 22) for c in ("y", "n", "u")]
    assert plugin.collab_text() == "Could you imagine collaborating with this person 🤝?"


def test_mark_keyboard_checks_the_tapped_button_only(plugin):
    nonce = "n" * 22
    rows = plugin.fit_rows(nonce, lambda t, d: Button(t, callback_data=d))
    marked = plugin.mark_keyboard(rows, plugin.fit_callback(4, nonce), lambda t, d: Button(t, callback_data=d))
    assert [b.text for b in marked[0]] == ["😕", "😐", "🙂", "✅ 😊", "🤩"]
    again = plugin.mark_keyboard(marked, plugin.fit_callback(2, nonce), lambda t, d: Button(t, callback_data=d))
    assert [b.text for b in again[0]] == ["😕", "✅ 😐", "🙂", "😊", "🤩"]


# --------------------------------------------------------------------------- owner


def test_owner_tap_rules(plugin, monkeypatch):
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OWNER)
    assert plugin.is_owner_tap(None, OWNER, OWNER, "private")
    assert not plugin.is_owner_tap(None, OTHER, OTHER, "private")  # not paired (no Hermes here)
    assert not plugin.is_owner_tap(None, OWNER, OTHER, "private")
    assert not plugin.is_owner_tap(None, OWNER, OWNER, "group")
    assert not plugin.is_owner_tap(None, None, OWNER, "private")
    adapter = types.SimpleNamespace(config=types.SimpleNamespace(home_channel={"chat_id": OTHER, "user_id": OTHER}))
    assert plugin.is_owner_tap(adapter, OTHER, OTHER, "private")
    assert plugin.home_chat_id(adapter) == OTHER


# --------------------------------------------------------------------------- stage -> card -> ledger -> record


def test_pickup_sends_card_one_records_the_ledger_and_hands_the_ask_over(plugin, home, on):
    path = stage(home, plugin)
    bot = Bot()
    codes = pickup(plugin, bot)
    assert codes == {"sent": 1}
    assert not path.exists()
    assert len(bot.sent) == 1
    sent = bot.sent[0]
    assert sent["chat_id"] == int(OWNER) and sent["parse_mode"] == "HTML"
    assert "Maya Rao, about Climate finance" in sent["text"]
    assert [b.text for b in sent["reply_markup"].inline_keyboard[0]] == ["😕", "😐", "🙂", "😊", "🤩"]
    card = ledger(home)["cards"][OPP]
    assert card["message_id"] == 101 and card["fit"] is None and card["collab"] is None and card["injected"] is False
    assert card["nonce"] == plugin.make_nonce(plugin.hash_key(), OPP)
    assert plugin.epoch_from_iso(card["closes_at"]) == pytest.approx(T0 + 24 * 3600)
    (record,) = records(home)
    assert record == {"event_type": "opportunity.rating_asked", "opportunity_id": OPP, "intention_id": None, "card": "fit", "revision": 1,
                      "value": None, "at": plugin.now_iso(T0), "message_hash": plugin.keyed_hash(plugin.hash_key(), sent["text"])}
    assert "Maya" not in json.dumps(record)
    # A second pass sends nothing more.
    assert pickup(plugin, bot) == {}


def test_pickup_is_off_without_the_switch_and_leaves_the_stage(plugin, home, monkeypatch):
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OWNER)
    path = stage(home, plugin)
    bot = Bot()
    assert pickup(plugin, bot) == {}
    assert path.exists() and not bot.sent


def test_pickup_without_a_home_chat_leaves_the_stage(plugin, home, monkeypatch):
    monkeypatch.setenv("AV_RATE_CARDS", "1")
    path = stage(home, plugin)
    assert pickup(plugin, Bot()) == {"no_home_chat": 1}
    assert path.exists()


@pytest.mark.parametrize("over, code", [
    ({"name": ""}, "stage_dropped_bad_shape"),
    ({"opportunity_id": "has space"}, "stage_dropped_bad_shape"),
    ({"extra": 1}, "stage_dropped_bad_shape"),
    ({"staged_at": "STALE"}, "stage_dropped_stale"),
])
def test_a_stage_not_the_shape_or_stale_is_dropped_and_counted(plugin, home, on, over, code):
    if over.get("staged_at") == "STALE":
        over = {"staged_at": plugin.now_iso(T0 - plugin.STAGE_MAX_AGE_S - 1)}
    path = stage(home, plugin, **over)
    bot = Bot()
    assert pickup(plugin, bot) == {code: 1}
    assert not path.exists() and not bot.sent


def test_a_stage_for_a_card_already_sent_is_dropped(plugin, home, on):
    stage(home, plugin)
    pickup(plugin, Bot())
    path = stage(home, plugin)
    assert pickup(plugin, Bot()) == {"stage_dropped_already_asked": 1}
    assert not path.exists()


def test_send_failures_keep_the_stage_then_drop_it(plugin, home, on):
    path = stage(home, plugin)
    bot = Bot(fail=5)
    assert pickup(plugin, bot) == {"send_failed": 1}
    assert path.exists()
    assert pickup(plugin, bot) == {"send_failed": 1}
    assert pickup(plugin, bot) == {"stage_dropped_send_failed": 1}
    assert not path.exists()


def test_a_private_stage_file_is_required(plugin, home, on):
    path = stage(home, plugin)
    os.chmod(path, 0o644)
    assert pickup(plugin, Bot()) == {"stage_dropped_not_private": 1}


# --------------------------------------------------------------------------- taps


def tapped(plugin, home, on, bot=None):
    stage(home, plugin)
    bot = bot or Bot()
    pickup(plugin, bot)
    return bot, ledger(home)["cards"][OPP]["nonce"]


def test_fit_tap_records_marks_sends_card_two_and_hands_the_event_over(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    rows = plugin.fit_rows(nonce, lambda t, d: Button(t, callback_data=d))
    query = Query(plugin.fit_callback(4, nonce), bot, rows=rows)
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=query)))
    assert query.answers == ["Recorded: Good fit"]
    assert [b.text for b in query.edits[0].inline_keyboard[0]] == ["😕", "😐", "🙂", "✅ 😊", "🤩"]
    card = ledger(home)["cards"][OPP]
    assert card["fit"] == {"value": 4, "revision": 1, "at": plugin.now_iso(T0 + 60)}
    assert card["collab_message_id"] == 102
    assert plugin.epoch_from_iso(card["closes_at_collab"]) == pytest.approx(T0 + 60 + 24 * 3600)
    assert bot.sent[1]["text"] == "Could you imagine collaborating with this person 🤝?"
    assert [[b.text for b in row] for row in bot.sent[1]["reply_markup"].inline_keyboard] == [["Yes", "No"], ["Not sure yet"]]
    kinds = [(r["event_type"], r["card"], r["revision"], r["value"]) for r in records(home)]
    assert kinds == [("opportunity.rating_asked", "fit", 1, None), ("opportunity.rated", "fit", 1, 4), ("opportunity.rating_asked", "collab", 1, None)]
    rated = [r for r in records(home) if r["event_type"] == "opportunity.rated"][0]
    assert rated["at"] == plugin.now_iso(T0 + 60) and rated["message_hash"] is None


def test_a_step_after_the_record_that_fails_never_answers_failed(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    bot.fail = 1  # card 2's send raises after the fit tap is saved and answered
    query = Query(plugin.fit_callback(3, nonce), bot)

    async def broken_edit(**_):
        raise RuntimeError("edit refused")

    query.edit_message_reply_markup = broken_edit
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=query)))
    assert query.answers == ["Recorded: OK fit"]
    assert plugin.FAILED not in query.answers
    assert ledger(home)["cards"][OPP]["fit"]["value"] == 3


def test_a_retap_is_a_revision_and_sends_no_second_card_two(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(2, nonce), bot))))
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(5, nonce), bot))))
    card = ledger(home)["cards"][OPP]
    assert card["fit"] == {"value": 5, "revision": 2, "at": plugin.now_iso(T0 + 60)}
    assert len(bot.sent) == 2
    assert [r["revision"] for r in records(home) if r["event_type"] == "opportunity.rated"] == [1, 2]


@pytest.mark.parametrize("fit", [1, 2, 3, 4, 5])
def test_every_rating_gets_the_collab_card(plugin, home, on, fit):
    bot, nonce = tapped(plugin, home, on)
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(fit, nonce), bot))))
    assert len(bot.sent) == 2 and bot.sent[1]["text"] == "Could you imagine collaborating with this person 🤝?"


def test_collab_tap_records_and_injects_the_line_once(plugin, home, on):
    ctx = Ctx()
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, ctx=ctx, now=T0 + 60)
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(2, nonce), bot))))
    assert ctx.calls == []  # the agent hears once card 2 resolves
    query = Query(plugin.collab_callback("u", nonce), bot, message_id=102)
    run(h(types.SimpleNamespace(callback_query=query)))
    assert query.answers == ["Recorded: Not sure yet"]
    assert ctx.calls == [("[Rating recorded] Maya Rao: 2/5 match fit; could imagine collaborating: unsure. Reply with exactly: Got it!", f"agent:main:telegram:dm:{OWNER}")]
    card = ledger(home)["cards"][OPP]
    assert card["collab"] == {"value": "unsure", "revision": 1, "at": plugin.now_iso(T0 + 60)} and card["injected"] is True
    collab = [r for r in records(home) if r["event_type"] == "opportunity.collab_interest"]
    assert collab == [{"event_type": "opportunity.collab_interest", "opportunity_id": OPP, "intention_id": None, "card": "collab", "revision": 1,
                       "value": "unsure", "at": plugin.now_iso(T0 + 60), "message_hash": None}]
    # A collab tap on card 1's message is refused; a revision does not inject again or send another card.
    wrong = Query(plugin.collab_callback("y", nonce), bot, message_id=101)
    run(h(types.SimpleNamespace(callback_query=wrong)))
    assert wrong.answers == [plugin.INVALID]
    run(h(types.SimpleNamespace(callback_query=Query(plugin.collab_callback("y", nonce), bot, message_id=102))))
    assert ledger(home)["cards"][OPP]["collab"]["revision"] == 2
    assert len(ctx.calls) == 1 and len(bot.sent) == 2
    # Card 2 closes 24 h after its own send.
    late = Query(plugin.collab_callback("n", nonce), bot, message_id=102)
    run(handler(plugin, ctx=ctx, now=T0 + 60 + 24 * 3600 + 1)(types.SimpleNamespace(callback_query=late)))
    assert late.answers == [plugin.CLOSED]


def test_a_retired_planned_card_is_still_recorded(plugin, home, on):
    """A "Did you already plan this meetup?" card sent by an older release can still be answered."""
    bot, nonce = tapped(plugin, home, on)
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(4, nonce), bot))))
    ledger_file = home / "av-events" / "proactive" / "rated.json"
    data = json.loads(ledger_file.read_text())
    data["cards"][OPP].update({"planned_message_id": 99, "closes_at_planned": plugin.now_iso(T0 + 60 + 24 * 3600)})
    ledger_file.write_text(json.dumps(data))
    query = Query(plugin.planned_callback("n", nonce), bot, message_id=99)
    run(handler(plugin, now=T0 + 120)(types.SimpleNamespace(callback_query=query)))
    assert query.answers == ["Recorded: No"]
    planned = [r for r in records(home) if r["event_type"] == "opportunity.pre_planned"]
    assert [(r["card"], r["value"]) for r in planned] == [("planned", "no")]
    assert len(bot.sent) == 2  # nothing more is sent


def test_an_early_answer_never_leaves_the_card_locked(plugin, home, on):
    """Review #492: "Already recorded" and "closed" used to keep the card in flight forever."""
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    for value, answer in ((3, "Recorded: OK fit"), (3, "Already recorded: OK fit"), (5, "Recorded: Great fit")):
        query = Query(plugin.fit_callback(value, nonce), bot)
        run(h(types.SimpleNamespace(callback_query=query)))
        assert query.answers == [answer]
    late = Query(plugin.fit_callback(4, nonce), bot)
    run(handler(plugin, now=T0 + 24 * 3600 + 1)(types.SimpleNamespace(callback_query=late)))
    assert late.answers == [plugin.CLOSED]
    assert plugin._in_flight == set()


def test_a_claimed_injection_is_not_due_until_the_claim_lapses(plugin, home, on):
    """Review #492: the tap and the pick-up must not inject one card twice."""
    card = {"fit": {"value": 4}, "collab": {"value": "yes"}, "injected": False}
    assert plugin.ready_to_inject(card, T0)
    card["inject_claimed_at"] = plugin.now_iso(T0)
    assert not plugin.ready_to_inject(card, T0 + 60)
    assert plugin.ready_to_inject(card, T0 + plugin.INJECT_CLAIM_S + 1)
    ctx = Ctx(accept=False)
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, ctx=ctx, now=T0 + 60)
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(2, nonce), bot))))
    assert plugin.claim_injection(None, OPP, T0 + 60) is None  # card 2 not answered yet
    run(h(types.SimpleNamespace(callback_query=Query(plugin.collab_callback("n", nonce), bot, message_id=102))))
    # The refused attempt released its claim: the next pick-up may try again.
    assert "inject_claimed_at" not in ledger(home)["cards"][OPP]
    assert plugin.claim_injection(None, OPP, T0 + 61) is not None
    assert plugin.claim_injection(None, OPP, T0 + 62) is None


def test_a_collab_card_that_cannot_be_sent_settles_on_card_one(plugin, home, on):
    """Review #492: a failed follow-up send used to hold the agent line for up to 24 h."""
    ctx = Ctx()
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, ctx=ctx, now=T0 + 60)
    bot.fail = 1
    query = Query(plugin.fit_callback(4, nonce), bot)
    run(h(types.SimpleNamespace(callback_query=query)))
    assert query.answers == ["Recorded: Good fit"]
    card = ledger(home)["cards"][OPP]
    assert card["collab_send_failed"] is True and card["collab_message_id"] is None and card["injected"] is True
    assert ctx.calls == [("[Rating recorded] Maya Rao: 4/5 match fit; could imagine collaborating: not answered. Reply with exactly: Got it!", f"agent:main:telegram:dm:{OWNER}")]


def test_a_collab_card_whose_send_timed_out_still_takes_its_tap(plugin, home, on):
    """Review #497: Telegram may take the message even when the send call fails."""
    ctx = Ctx()
    bot, nonce = tapped(plugin, home, on)
    bot.fail = 1
    run(handler(plugin, ctx=ctx, now=T0 + 60)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(3, nonce), bot))))
    query = Query(plugin.collab_callback("y", nonce), bot, message_id=777)
    run(handler(plugin, ctx=ctx, now=T0 + 120)(types.SimpleNamespace(callback_query=query)))
    assert query.answers == ["Recorded: Yes"]
    card = ledger(home)["cards"][OPP]
    assert card["collab_message_id"] == 777 and card["collab"]["value"] == "yes"
    assert len(ctx.calls) == 1  # told once, at the failed send
    assert [r["value"] for r in records(home) if r["event_type"] == "opportunity.collab_interest"] == ["yes"]


def test_an_older_releases_answered_planned_card_settles_at_once(plugin):
    card = {"fit": {"value": 4}, "planned": {"value": "no"}, "injected": False, "closes_at": plugin.now_iso(T0 + 24 * 3600)}
    assert plugin.ready_to_inject(card, T0 + 60)


def test_the_pickup_injects_when_the_collab_card_is_left_unanswered(plugin, home, on):
    ctx = Ctx()
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, ctx=ctx, now=T0 + 60)
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(5, nonce), bot))))
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 60 + 24 * 3600 - 1) == {}
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 60 + 24 * 3600 + 1) == {"injected": 1}
    assert ctx.calls == [("[Rating recorded] Maya Rao: 5/5 match fit; could imagine collaborating: not answered. Reply with exactly: Got it!", f"agent:main:telegram:dm:{OWNER}")]


def test_injection_refused_or_erroring_never_blocks_the_tap(plugin, home, on):
    for ctx in (Ctx(accept=False), Ctx(raises=True), None):
        for path in (home / "av-events" / "proactive").glob("*.json"):
            path.unlink()
        bot, nonce = tapped(plugin, home, on)
        h = handler(plugin, ctx=ctx, now=T0 + 60)
        run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(1, nonce), bot))))
        query = Query(plugin.collab_callback("y", nonce), bot, message_id=102)
        run(h(types.SimpleNamespace(callback_query=query)))
        assert query.answers == ["Recorded: Yes"]


def test_session_key_override(plugin, monkeypatch):
    assert plugin.session_key_for("42") == "agent:main:telegram:dm:42"
    monkeypatch.setenv("AV_RATE_SESSION_KEY", "agent:prof:telegram:dm:42")
    assert plugin.session_key_for("42") == "agent:prof:telegram:dm:42"


def test_each_card_has_its_own_24_hour_window_then_the_pickup_injects_card_one_alone(plugin, home, on):
    """Review round 1, decision 2: card 2's window runs from card 2's own send."""
    ctx = Ctx()
    bot, nonce = tapped(plugin, home, on)
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(3, nonce), bot))))
    card = ledger(home)["cards"][OPP]
    assert plugin.epoch_from_iso(card["closes_at_collab"]) == pytest.approx(T0 + 60 + 24 * 3600)
    # Card 1 closed, card 2 still open: a collab tap is taken, a fit re-tap is not.
    late_fit = Query(plugin.fit_callback(2, nonce), bot)
    run(handler(plugin, now=T0 + 24 * 3600 + 1)(types.SimpleNamespace(callback_query=late_fit)))
    assert late_fit.answers == ["This question has closed."]
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 24 * 3600 + 1) == {}  # card 2 still open: not injected yet
    late = Query(plugin.collab_callback("y", nonce), bot, message_id=102)
    run(handler(plugin, now=T0 + 60 + 24 * 3600 + 1)(types.SimpleNamespace(callback_query=late)))
    assert late.answers == ["This question has closed."]
    assert ledger(home)["cards"][OPP]["collab"] is None
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 60 + 24 * 3600 + 1) == {"injected": 1}
    assert ctx.calls == [("[Rating recorded] Maya Rao: 3/5 match fit; could imagine collaborating: not answered. Reply with exactly: Got it!", f"agent:main:telegram:dm:{OWNER}")]
    # An unanswered card is never injected.
    stage(home, plugin, opp=OPP2)
    pickup(plugin, bot, now=T0)
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 2 * 24 * 3600) == {}


def test_taps_from_others_unknown_nonces_and_core_buttons(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    other = Query(plugin.fit_callback(4, nonce), bot, user=OTHER, chat=OTHER)
    run(h(types.SimpleNamespace(callback_query=other)))
    assert other.answers == ["This card is not yours"]
    unknown = Query(plugin.fit_callback(4, "z" * 22), bot)
    run(h(types.SimpleNamespace(callback_query=unknown)))
    assert unknown.answers == ["This card is no longer valid."]
    bad = Query("cp:fast:on", bot)
    run(h(types.SimpleNamespace(callback_query=bad)))
    assert bad.answers == ["This button is not valid."]
    assert ledger(home)["cards"][OPP]["fit"] is None
    assert len(records(home)) == 1


def test_double_tap_in_flight_is_answered_and_recorded_once(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    first = Query(plugin.fit_callback(4, nonce), bot)
    second = Query(plugin.fit_callback(5, nonce), bot)
    plugin._in_flight.add((OWNER, "101"))
    try:
        run(h(types.SimpleNamespace(callback_query=second)))
    finally:
        plugin._in_flight.discard((OWNER, "101"))
    assert second.answers == ["Still recording..."]
    run(h(types.SimpleNamespace(callback_query=first)))
    assert ledger(home)["cards"][OPP]["fit"]["value"] == 4


def test_register_stores_the_context_and_wires_the_platform_handler(plugin):
    wired = []
    ctx = types.SimpleNamespace(register_platform_handler=lambda platform, factory: wired.append((platform, factory)), inject_message=lambda *a, **k: True)
    plugin.register(ctx)
    assert wired == [("telegram", plugin._wire_telegram)]
    assert plugin._CTX is ctx


def test_logs_carry_codes_only(plugin, home, on, caplog):
    import logging

    caplog.set_level(logging.INFO)
    bot, nonce = tapped(plugin, home, on)
    run(handler(plugin, now=T0 + 60)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(4, nonce), bot))))
    text = caplog.text
    assert "Maya" not in text and nonce not in text and OWNER not in text and OPP not in text
    assert "outcome=recorded" in text and f"tenant={TENANT[:8]}" in text


# --------------------------------------------------------------------------- review round 1: the ledger under concurrency


class TappingBot(Bot):
    """A bot whose send awaits a tap on another card first: the pick-up and a tap interleave across the await."""

    def __init__(self, tap):
        super().__init__()
        self.tap = tap

    async def send_message(self, **kwargs):
        if self.tap is not None:
            tap, self.tap = self.tap, None
            await tap()
        return await super().send_message(**kwargs)


def test_a_tap_during_a_send_is_never_lost(plugin, home, on):
    """BLOCKER: the old pass held an RLock across the await and saved a stale ledger over the tap."""
    bot, nonce = tapped(plugin, home, on)  # card A sent (message 101)
    stage(home, plugin, opp=OPP2)  # card B staged

    async def tap_a():
        await handler(plugin, now=T0 + 30)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(5, nonce), bot)))

    tapping = TappingBot(tap_a)
    tapping._next = bot._next
    assert pickup(plugin, tapping, now=T0 + 60) == {"sent": 1}
    cards = ledger(home)["cards"]
    assert cards[OPP]["fit"] == {"value": 5, "revision": 1, "at": plugin.now_iso(T0 + 30)}, "the tap survived the send"
    assert cards[OPP2]["message_id"] is not None
    # The next tap on A is a revision, not a first tap: no second card 2.
    sent_before = len(bot.sent) + len(tapping.sent)
    run(handler(plugin, now=T0 + 90)(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(2, nonce), bot))))
    assert ledger(home)["cards"][OPP]["fit"]["revision"] == 2
    assert len(bot.sent) + len(tapping.sent) == sent_before


def test_a_card_is_written_ahead_of_its_send_and_never_sent_twice(plugin, home, on):
    """A pending card (write-ahead) with no message id from another process is kept as asked, not re-sent."""
    stage(home, plugin)
    pending = {"v": 1, "cards": {OPP: {"nonce": "n" * 22, "intention_id": None, "name": "Maya Rao", "agent_name": "Edge", "chat_id": OWNER,
                                      "message_id": None, "planned_message_id": None, "pending_since": plugin.now_iso(T0 - 30), "pid": 1,
                                      "sent_at": None, "closes_at": None, "closes_at_planned": None, "fit": None, "planned": None, "injected": False}},
               "evicted": []}
    plugin.write_private(plugin.ledger_path(), pending)
    bot = Bot()
    assert pickup(plugin, bot) == {"stage_resolved_pending": 1}
    assert not bot.sent
    card = ledger(home)["cards"][OPP]
    assert card["send_unknown"] is True and card["sent_at"] is not None and card["closes_at"] is not None
    (record,) = records(home)
    assert record["event_type"] == "opportunity.rating_asked"
    # A send that fails withdraws the reservation so the next pass can try again.
    stage(home, plugin, opp=OPP2)
    failing = Bot(fail=1)
    assert pickup(plugin, failing) == {"send_failed": 1}
    assert OPP2 not in ledger(home)["cards"]
    assert pickup(plugin, failing) == {"sent": 1}


def test_evicted_cards_leave_tombstones_that_stay_asked(plugin, home, on, monkeypatch):
    monkeypatch.setattr(plugin, "LEDGER_MAX_CARDS", 2)
    ids = [f"{i}b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d" for i in range(4)]
    for i, opp in enumerate(ids):
        stage(home, plugin, opp=opp, staged_at=plugin.now_iso(T0 - 60 + i))
        pickup(plugin, Bot(), now=T0 + i)
    data = ledger(home)
    assert set(data["cards"]) == set(ids[2:])
    assert data["evicted"] == ids[:2]
    stage(home, plugin, opp=ids[0])
    assert pickup(plugin, Bot(), now=T0 + 10) == {"stage_dropped_already_asked": 1}


def test_a_tap_with_no_message_or_on_another_message_is_refused(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    no_message = types.SimpleNamespace(data=plugin.fit_callback(4, nonce), from_user=types.SimpleNamespace(id=int(OWNER)), message=None, answers=[])

    async def answer(text=None, **_):
        no_message.answers.append(text)

    no_message.answer = answer
    run(h(types.SimpleNamespace(callback_query=no_message)))
    assert no_message.answers == ["This card is not yours"]
    wrong = Query(plugin.fit_callback(4, nonce), bot, message_id=999)
    run(h(types.SimpleNamespace(callback_query=wrong)))
    assert wrong.answers == ["This card is no longer valid."]
    planned_on_card_one = Query(plugin.planned_callback("y", nonce), bot, message_id=101)
    run(h(types.SimpleNamespace(callback_query=planned_on_card_one)))
    assert planned_on_card_one.answers == ["This card is no longer valid."]
    assert ledger(home)["cards"][OPP]["fit"] is None


def test_the_same_value_again_is_already_recorded_not_a_revision(plugin, home, on):
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, now=T0 + 60)
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(4, nonce), bot))))
    again = Query(plugin.fit_callback(4, nonce), bot)
    run(h(types.SimpleNamespace(callback_query=again)))
    assert again.answers == ["Already recorded: Good fit"]
    assert ledger(home)["cards"][OPP]["fit"]["revision"] == 1
    assert [r["revision"] for r in records(home) if r["event_type"] == "opportunity.rated"] == [1]
    run(h(types.SimpleNamespace(callback_query=Query(plugin.collab_callback("n", nonce), bot, message_id=102))))
    same = Query(plugin.collab_callback("n", nonce), bot, message_id=102)
    run(h(types.SimpleNamespace(callback_query=same)))
    assert same.answers == ["Already recorded: No"]
    assert len([r for r in records(home) if r["event_type"] == "opportunity.collab_interest"]) == 1


def test_a_mixed_case_uuid_is_one_card(plugin, home, on):
    stage(home, plugin, opp=OPP.upper())
    assert pickup(plugin, Bot()) == {"sent": 1}
    assert list(ledger(home)["cards"]) == [OPP]
    stage(home, plugin, opp=OPP)
    assert pickup(plugin, Bot()) == {"stage_dropped_already_asked": 1}


def test_injection_is_retried_up_to_the_cap_then_closed(plugin, home, on):
    ctx = Ctx(accept=False)
    bot, nonce = tapped(plugin, home, on)
    h = handler(plugin, ctx=ctx, now=T0 + 60)
    run(h(types.SimpleNamespace(callback_query=Query(plugin.fit_callback(4, nonce), bot))))
    run(h(types.SimpleNamespace(callback_query=Query(plugin.collab_callback("y", nonce), bot, message_id=102))))
    assert ledger(home)["cards"][OPP]["inject_attempts"] == 1 and ledger(home)["cards"][OPP]["injected"] is False
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 120) == {"inject_refused": 1}
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 180) == {"inject_refused": 1}
    card = ledger(home)["cards"][OPP]
    assert card["injected"] is True and card["injected_code"] == "inject_gave_up" and card["inject_attempts"] == plugin.INJECT_ATTEMPTS_MAX
    assert pickup(plugin, bot, ctx=ctx, now=T0 + 240) == {}
    assert len(ctx.calls) == 3


# --------------------------------------------------------------------------- wave 1: the resident's controls


IST_2AM = T0 - 12 * 3600  # 2025-10-08T20:53Z = 02:23 Asia/Kolkata


def test_quiet_hours_defer_the_stage_by_default(plugin, home, on):
    path = stage(home, plugin, staged_at=plugin.now_iso(IST_2AM - 60))
    bot = Bot()
    assert pickup(plugin, bot, now=IST_2AM) == {"deferred_quiet_hours": 1}
    assert path.exists() and not bot.sent
    assert plugin.QUIET_DEFAULT_WINDOW == (8 * 60, 22 * 60)
    assert pickup(plugin, bot, now=T0) == {"sent": 1}


def write_settings(home, text):
    folder = home / "av-events"
    folder.mkdir(exist_ok=True)
    (folder / "job-settings.json").write_text(text)


def test_the_residents_evening_window_rules_the_send(plugin, home, on):
    # 02:23 IST is inside a 01:00-03:00 window the resident set.
    write_settings(home, json.dumps({"v": 1, "jobs": {"evening": {"window": "01:00-03:00"}}}))
    stage(home, plugin, staged_at=plugin.now_iso(IST_2AM - 60))
    assert pickup(plugin, Bot(), now=IST_2AM) == {"sent": 1}
    # 14:23 IST is outside it.
    stage(home, plugin, opp=OPP2)
    assert pickup(plugin, Bot(), now=T0) == {"deferred_quiet_hours": 1}
    # A zone of their own: 14:23 IST is 10:53 Europe/Berlin (CEST), outside 11:00-12:00 and inside 10:00-11:00.
    write_settings(home, json.dumps({"v": 1, "jobs": {"evening": {"window": "11:00-12:00", "tz": "Europe/Berlin"}}}))
    assert pickup(plugin, Bot(), now=T0) == {"deferred_quiet_hours": 1}
    write_settings(home, json.dumps({"v": 1, "jobs": {"evening": {"window": "10:00-11:00", "tz": "Europe/Berlin"}}}))
    assert pickup(plugin, Bot(), now=T0) == {"sent": 1}


@pytest.mark.parametrize("text, code", [
    ("{not json", "file-unreadable"),
    ("[]", "file-not-object"),
    (json.dumps({"v": 2, "jobs": {}}), "file-version"),
    (json.dumps({"v": 1, "jobs": []}), "file-jobs"),
    (json.dumps({"v": 1, "jobs": {"evening": "19:00-20:00"}}), "entry"),
    (json.dumps({"v": 1, "jobs": {"evening": {"window": "7:00-20:00"}}}), "window"),
    (json.dumps({"v": 1, "jobs": {"evening": {"window": "19:00-19:00"}}}), "window"),
    (json.dumps({"v": 1, "jobs": {"evening": {"tz": "Etc/UTC"}}}), "tz"),
    (json.dumps({"v": 1, "jobs": {"evening": {"tz": "US/Eastern"}}}), "tz"),
])
def test_invalid_settings_defer_never_widen(plugin, home, on, text, code):
    """job-settings.ts: a value that fails its grammar is never used; the evening has no default window, so it holds."""
    write_settings(home, text)
    assert plugin.quiet_delivery()[2] == code
    path = stage(home, plugin)
    assert pickup(plugin, Bot(), now=T0) == {"deferred_settings_invalid": 1}
    assert path.exists()


def test_settings_without_an_evening_entry_use_the_default_quiet_hours(plugin, home):
    write_settings(home, json.dumps({"v": 1, "jobs": {"brief": {"window": "06:00-09:00"}}, "adminSchedules": ["brief"]}))
    assert plugin.quiet_delivery() == ((8 * 60, 22 * 60), "Asia/Kolkata", None)
    write_settings(home, json.dumps({"v": 1}))
    assert plugin.quiet_delivery() == ((8 * 60, 22 * 60), "Asia/Kolkata", None)
    assert plugin.parse_window("23:00-01:00") == (23 * 60, 60) and plugin.in_window(0, (23 * 60, 60)) and not plugin.in_window(12 * 60, (23 * 60, 60))


def write_jobs(home, enabled=True, installed=True, **extra):
    (home / "cron").mkdir(exist_ok=True)
    job = {"id": "abcdef012345", "name": "Edge — evening questions", "enabled": enabled, **extra}
    (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [job, {"id": "0123456789ab", "name": "Edge — evening questions", "enabled": False}]}))
    if installed:
        (home / "av-events" / "installed_jobs.json").write_text(json.dumps({"ids": ["abcdef012345"]}))


def test_a_stopped_evening_job_defers_the_stage_until_resumed(plugin, home, on):
    write_jobs(home, enabled=False)
    assert plugin.evening_job_state() == "stopped"
    path = stage(home, plugin)
    bot = Bot()
    assert pickup(plugin, bot, now=T0) == {"deferred_job_stopped": 1}
    assert path.exists() and not bot.sent
    write_jobs(home, enabled=True)
    assert plugin.evening_job_state() == "running"
    assert pickup(plugin, bot, now=T0) == {"sent": 1}


@pytest.mark.parametrize("extra", [{"state": "paused"}, {"paused_at": "2026-10-21T00:00:00Z"}])
def test_a_paused_job_is_stopped_too(plugin, home, extra):
    write_jobs(home, enabled=True, **extra)
    assert plugin.evening_job_state() == "stopped"


def test_a_job_of_the_residents_own_with_our_name_is_not_ours(plugin, home):
    # The disabled second job is not in installed_jobs.json: the resident's own, never read.
    (home / "cron").mkdir(exist_ok=True)
    (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [{"id": "0123456789ab", "name": "Edge — evening questions", "enabled": False}]}))
    assert plugin.evening_job_state() == "absent"
    (home / "cron" / "jobs.json").write_text("{not json")
    assert plugin.evening_job_state() == "unreadable"


def test_an_unreadable_job_store_defers(plugin, home, on):
    (home / "cron").mkdir(exist_ok=True)
    (home / "cron" / "jobs.json").write_text("{not json")
    path = stage(home, plugin)
    assert pickup(plugin, Bot(), now=T0) == {"deferred_jobs_unreadable": 1}
    assert path.exists()


def test_a_team_tenant_never_gets_a_card(plugin, home, on, monkeypatch):
    monkeypatch.setenv("AV_TEAM_TENANT", "1")
    path = stage(home, plugin)
    bot = Bot()
    assert pickup(plugin, bot, now=T0) == {"stage_dropped_team_tenant": 1}
    assert not path.exists() and not bot.sent
    monkeypatch.setenv("AV_TEAM_TENANT", '"1"')
    assert plugin.team_tenant() is False
    monkeypatch.delenv("AV_TEAM_TENANT")
    (home / ".env").write_text("AV_TEAM_TENANT=0\nexport AV_TEAM_TENANT = 1 \n")
    assert plugin.team_tenant() is True


class RetryAfter(RuntimeError):
    def __init__(self, seconds):
        super().__init__("flood")
        self.retry_after = seconds


class RateLimitedBot(Bot):
    def __init__(self, seconds):
        super().__init__()
        self.limit = seconds

    async def send_message(self, **kwargs):
        if self.limit is not None:
            seconds, self.limit = self.limit, None
            raise RetryAfter(seconds)
        return await super().send_message(**kwargs)


def test_a_rate_limit_waits_retry_after_before_the_next_attempt(plugin, home, on):
    path = stage(home, plugin)
    bot = RateLimitedBot(90)
    assert pickup(plugin, bot, now=T0) == {"send_rate_limited": 1}
    assert path.exists() and OPP not in ledger(home)["cards"]
    assert pickup(plugin, bot, now=T0 + 60) == {"deferred_rate_limited": 1}
    assert pickup(plugin, bot, now=T0 + 91) == {"sent": 1}
    assert plugin._retry_after_of(RetryAfter(5)) == 5.0 and plugin._retry_after_of(RuntimeError("x")) is None


def test_a_stage_three_days_old_is_dropped_not_sent(plugin, home, on):
    assert plugin.STAGE_MAX_AGE_S == 3 * 24 * 3600
    path = stage(home, plugin, staged_at=plugin.now_iso(T0 - plugin.STAGE_MAX_AGE_S - 1))
    assert pickup(plugin, Bot(), now=T0) == {"stage_dropped_stale": 1}
    assert not path.exists()
    path = stage(home, plugin, staged_at=plugin.now_iso(T0 - plugin.STAGE_MAX_AGE_S + 60))
    assert pickup(plugin, Bot(), now=T0) == {"sent": 1}
