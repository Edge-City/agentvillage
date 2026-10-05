"""DATA-42 (ruling R2): the evening outcome ask, the plugin's half (`_outcome_ask`).

The trigger's half (the pick, the stage file, the prompts) is
`skills/index-network/scripts/tests/outcome-ask.test.ts`.

The last two sections close the review's two flags: "integrity / trust
boundary (forged stage file)" and "integrity / trust boundary" (armed files,
the asks on file, answers). Every file here is in the agent's own home, where
the model can write.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

TENANT = "tenant-0b7d"
JOB = "ab12cd34ef56"
OTHER_JOB = "0123456789ab"
OPP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
OUTCOME = f"opp-outcome:{OPP}"
QUESTION = "Did you and Arjun meet? Reply met, not useful, or missed."
IST = timezone(timedelta(hours=5, minutes=30))

#: `cron/executions.py`'s table with the `delivery_outcome` column later tags add.
SCHEMA = """CREATE TABLE executions (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT NOT NULL, process_id TEXT NOT NULL,
    pid INTEGER NOT NULL, process_started_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('claimed','running','completed','failed','unknown')),
    claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT{extra})"""


def stamp(epoch: float) -> str:
    """How Hermes writes it: local offset and all."""
    return datetime.fromtimestamp(epoch, timezone.utc).astimezone(IST).isoformat()


def utc(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


class Tenant:
    """A `$HERMES_HOME` with the installer's evening job and Hermes's executions ledger."""

    def __init__(self, home, *, delivery_column: bool = True, name: str = "Edge — evening questions", installed: bool = True):
        self.home = home
        self.cron = home / "cron"
        self.cron.mkdir(parents=True, exist_ok=True)
        self.state = home / "av-events"
        self.state.mkdir(exist_ok=True)
        self.delivery_column = delivery_column
        with sqlite3.connect(self.cron / "executions.db") as conn:
            conn.execute(SCHEMA.format(extra=", delivery_outcome TEXT" if delivery_column else ""))
        (self.cron / "jobs.json").write_text(json.dumps({"jobs": [{"id": JOB, "name": name}, {"id": OTHER_JOB, "name": "Edge — daily digest"}]}))
        (self.state / "installed_jobs.json").write_text(json.dumps({"ids": [JOB, OTHER_JOB] if installed else [OTHER_JOB]}))

    @property
    def stage_file(self):
        return self.state / "proactive" / "outcome-ask-evening.json"

    def stage_body(self, *, at: float | None = None, subjects=None, **over) -> dict:
        staged = time.time() - 5 if at is None else at
        body = {
            "v": 1, "action": "evening", "date": datetime.fromtimestamp(staged, IST).date().isoformat(),
            "staged_at": utc(staged), "asked_by": "outcome_cron", "window_days": 1,
            "subjects": subjects or [{"outcome_id": OUTCOME, "opportunity_id": OPP}],
        }
        body.update(over)
        return body

    def write_private(self, path, body) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body if isinstance(body, str) else json.dumps(body))
        os.chmod(path, 0o600)

    def stage(self, **kwargs) -> None:
        self.write_private(self.stage_file, self.stage_body(**kwargs))

    def start(self, execution: str, *, at: float | None = None, job: str = JOB) -> None:
        begin = time.time() - 30 if at is None else at
        values = [execution, job, "tick", "p", 1, None, "running", stamp(begin), stamp(begin + 1), None, None]
        if self.delivery_column:
            values.append(None)
        with sqlite3.connect(self.cron / "executions.db") as conn:
            conn.execute(f"INSERT OR IGNORE INTO executions VALUES ({','.join('?' * len(values))})", values)

    def finish(self, execution: str, *, at: float | None = None, status: str = "completed", delivery: str | None = "delivered", job: str = JOB) -> None:
        end = time.time() if at is None else at
        self.start(execution, at=end - 40, job=job)
        with sqlite3.connect(self.cron / "executions.db") as conn:
            if self.delivery_column:
                conn.execute("UPDATE executions SET status=?, finished_at=?, delivery_outcome=? WHERE id=?", (status, stamp(end), delivery, execution))
            else:
                conn.execute("UPDATE executions SET status=?, finished_at=? WHERE id=?", (status, stamp(end), execution))

    def asked_ledger(self) -> dict:
        path = self.state / "proactive" / "outcome-asked.json"
        return json.loads(path.read_text())["asked"] if path.exists() else {}

    @property
    def armed_dir(self):
        return self.state / "outcome-ask" / "armed"

    def armed(self) -> list[str]:
        return sorted(os.listdir(self.armed_dir)) if self.armed_dir.exists() else []


@pytest.fixture()
def tenant(home):
    return Tenant(home)


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", TENANT)
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="tg1", model="m", platform="telegram")
    return plugin


def module(plugin):
    return sys.modules[f"{plugin.__name__}._outcome_ask"]


def events(av, plugin, event_type=None):
    found = av.read_buffer(plugin._COLLECTOR)
    return [e for e in found if event_type is None or e["event_type"] == event_type]


def evening_reply(ctx, tenant, execution: str, text: str = QUESTION, job: str = JOB, start: bool = True) -> None:
    if start:
        tenant.start(execution, job=job)
    session = f"cron_{job}_20261014_190000"
    ctx.fire("on_session_start", session_id=session, model="m", platform="cron")
    ctx.fire("post_llm_call", session_id=session, task_id=f"cron:{job}:{execution}", turn_id="t1",
             user_message="the job prompt", assistant_response=text, model="m", platform="cron", conversation_history=[])


def resident_says(ctx, text: str, *, session: str = "tg1", platform: str = "telegram", history=None) -> None:
    ctx.fire("pre_llm_call", session_id=session, task_id=session, turn_id=f"turn-{uuid.uuid4().hex[:8]}", user_message=text,
             platform=platform, model="m", conversation_history=history if history is not None else [{"role": "user", "content": text}])


def ask_delivered(live, ctx, tenant, *, execution=None, delivery="delivered", **stage) -> str:
    execution = execution or uuid.uuid4().hex
    tenant.stage(**stage)
    evening_reply(ctx, tenant, execution)
    tenant.finish(execution, delivery=delivery)
    live._COLLECTOR.outcome_tick()
    return execution


def notes(plugin) -> list[dict]:
    return module(plugin).pending_answers()


# -- the ask ------------------------------------------------------------------


@pytest.mark.parametrize("delivery", ["delivered", "queued"])
def test_the_ask_is_emitted_only_once_delivered_or_queued(live, ctx, tenant, av, delivery):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    assert not tenant.stage_file.exists()
    assert tenant.armed() == [f"{execution}.json"]
    # Before the ledger says so, nothing is emitted.
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == []
    tenant.finish(execution, delivery=delivery)
    assert live._COLLECTOR.outcome_tick().get("asked") == 1
    [asked] = events(av, live, "outcome.asked")
    [out] = [e for e in events(av, live, "message.out") if e["session_id"].startswith("cron_")]
    assert asked["payload"] == {"message_hash": out["payload"]["content_hash"], "window_days": 1, "asked_by": "outcome_cron"}
    assert asked["payload"]["message_hash"] and len(asked["payload"]["message_hash"]) == 64
    assert asked["outcome_id"] == OUTCOME and asked["opportunity_id"] == OPP
    assert asked["run_id"] == f"cron:{JOB}:{execution}"
    assert asked["session_id"] == f"cron_{JOB}_20261014_190000"
    assert asked["evidence_class"] == "agent_report" and asked["actor"] == "agent"
    assert uuid.UUID(asked["event_id"]).version == 7
    assert QUESTION not in json.dumps(asked)
    assert list(tenant.asked_ledger()) == [OPP]
    assert tenant.armed() == []
    # A second pass (or a second process) emits nothing more.
    live._COLLECTOR.outcome_tick()
    assert len(events(av, live, "outcome.asked")) == 1


def test_the_asks_times_come_from_hermess_ledger_not_from_a_file(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    end = time.time() + 0.5
    tenant.finish(execution, at=end)
    live._COLLECTOR.outcome_tick()
    [asked] = events(av, live, "outcome.asked")
    assert asked["occurred_at"] == asked["occurred_at_latest"]
    assert abs(datetime.fromisoformat(asked["occurred_at"].replace("Z", "+00:00")).timestamp() - end) < 0.01


def test_nothing_on_silent(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution, "[SILENT]")
    assert not tenant.stage_file.exists()
    assert tenant.armed() == []
    tenant.finish(execution, delivery="suppressed")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == []
    assert tenant.asked_ledger() == {}


NOT_THE_QUESTION = {
    "a second person added": "Hi! Did you and Arjun meet? Also, did you get to talk to Priya? Reply met, not useful, or missed.",
    "a reminder about someone else": "Priya is still waiting to hear from you. [message Priya](https://t.me/x)",
    "Hermes's error text": "Sorry, I hit an error and could not finish this note.",
    "the question with a line after it": f"{QUESTION}\n\nHave a good evening!",
    "the question with a greeting before it": f"Good evening! {QUESTION}",
    "a name over 64 characters": f"Did you and {'A' * 65} meet? Reply met, not useful, or missed.",
    "no name": "Did you and meet? Reply met, not useful, or missed.",
    "the question twice": f"{QUESTION}\n{QUESTION}",
}


@pytest.mark.parametrize("label", sorted(NOT_THE_QUESTION))
def test_a_reply_that_is_not_the_fixed_question_is_treated_as_silent(live, ctx, tenant, av, label):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution, NOT_THE_QUESTION[label])
    assert not tenant.stage_file.exists(), label
    assert tenant.armed() == [], label
    tenant.finish(execution)
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == [], label
    # The subject stays due: nothing in the asked ledger.
    assert tenant.asked_ledger() == {}


def test_the_question_with_surrounding_whitespace_still_arms(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution, f"\n  {QUESTION}  \n")
    tenant.finish(execution)
    assert live._COLLECTOR.outcome_tick().get("asked") == 1


def test_the_question_pattern_is_the_one_shared_constant(plugin):
    """`outcome_question.json` is also what the bun test pins the evening
    prompt's sentence against (`install/tests/proactive_jobs.test.ts`)."""
    mod = module(plugin)
    seed = json.loads(open(mod.QUESTION_FILE, encoding="utf-8").read())
    assert seed["pattern"] == r"^Did you and .{1,64} meet\? Reply met, not useful, or missed\.$"
    assert mod.QUESTION_PATTERN.pattern == seed["pattern"]
    assert mod.QUESTION_MARKER == seed["marker"] == "Reply met, not useful, or missed."
    assert mod.is_the_question(QUESTION)
    assert mod.is_the_question(f"Did you and {'A' * 64} meet? Reply met, not useful, or missed.")
    assert not mod.is_the_question(None)


@pytest.mark.parametrize("status,delivery", [("completed", "failed"), ("completed", "suppressed"), ("completed", "not_configured"),
                                             ("completed", None), ("failed", "delivered"), ("unknown", None)])
def test_nothing_on_failed_delivery_and_the_subject_stays_due(live, ctx, tenant, av, status, delivery):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    tenant.finish(execution, status=status, delivery=delivery)
    assert live._COLLECTOR.outcome_tick().get("not_delivered") == 1
    assert events(av, live, "outcome.asked") == []
    # Not in the asked ledger, so the trigger asks again the next evening.
    assert tenant.asked_ledger() == {}
    assert tenant.armed() == []


def test_a_hermes_without_the_delivery_column_counts_a_completed_run(plugin, ctx, home, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    tenant = Tenant(home, delivery_column=False)
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    tenant.finish(execution)
    plugin._COLLECTOR.outcome_tick()
    assert len(events(av, plugin, "outcome.asked")) == 1


def test_a_stale_stage_file_is_ignored_and_removed(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.start(execution, at=time.time() - 30 * 60)
    tenant.stage(at=time.time() - 20 * 60)
    evening_reply(ctx, tenant, execution, start=False)
    assert not tenant.stage_file.exists()
    assert tenant.armed() == []
    # The tick sweeps one no run ever reached, too.
    tenant.stage(at=time.time() - 16 * 60)
    live._COLLECTOR.outcome_tick()
    assert not tenant.stage_file.exists()
    tenant.finish(execution)
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == []


def test_two_runs_racing_for_one_stage_arm_it_once(live, tenant):
    mod = module(live)
    collector = live._COLLECTOR
    tenant.stage()
    tenant.start("a" * 32)
    tenant.start("b" * 32)
    args = dict(reply=QUESTION, hasher=collector.keyed_hash, capture="sanitized", now=time.time())
    first = mod.arm(collector.config.state_dir, str(tenant.home), session_id="s", task_id=f"cron:{JOB}:{'a' * 32}", **args)
    second = mod.arm(collector.config.state_dir, str(tenant.home), session_id="s", task_id=f"cron:{JOB}:{'b' * 32}", **args)
    assert (first, second) == ("armed", "no_stage")
    assert tenant.armed() == [f"{'a' * 32}.json"]


def test_only_the_installers_evening_job_arms(plugin, ctx, home, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    # A participant's job named exactly like the installer's: its id was never recorded.
    tenant = Tenant(home, installed=False)
    tenant.stage()
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    assert tenant.stage_file.exists() and tenant.armed() == []
    # Another installer job (the brief) never arms either.
    evening_reply(ctx, tenant, uuid.uuid4().hex, job=OTHER_JOB)
    assert tenant.stage_file.exists() and tenant.armed() == []


def test_cron_sessions_are_handled_explicitly(live, ctx, tenant, av):
    """A cron run's reply arms (from `post_llm_call`), its prompt is never an
    answer (from `pre_llm_call`), and a chat turn never arms."""
    tenant.stage()
    tenant.start("c" * 32)
    session = f"cron_{JOB}_20261014_190000"
    ctx.fire("pre_llm_call", session_id=session, task_id=f"cron:{JOB}:{'c' * 32}", user_message="met", platform="cron",
             model="m", conversation_history=[{"role": "user", "content": "met"}])
    assert notes(live) == []
    ctx.fire("post_llm_call", session_id="tg1", task_id=f"cron:{JOB}:{'c' * 32}", assistant_response=QUESTION, platform="telegram")
    assert tenant.armed() == [] and tenant.stage_file.exists()
    evening_reply(ctx, tenant, "c" * 32, start=False)
    assert tenant.armed() == [f"{'c' * 32}.json"]


def test_metadata_capture_sends_the_ask_without_a_hash(plugin, ctx, home, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    tenant = Tenant(home)
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    tenant.finish(execution)
    plugin._COLLECTOR.outcome_tick()
    [asked] = events(av, plugin, "outcome.asked")
    assert asked["payload"]["message_hash"] is None


def test_an_armed_run_survives_a_restart(live, ctx, tenant, av, plugin):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    tenant.finish(execution)
    module(plugin).reset_memory()  # the next process remembers nothing
    other = sys.modules[f"{plugin.__name__}._collector"].Collector()
    other._stop.set()
    assert other.outcome_tick().get("asked") == 1
    assert len([e for e in av.read_buffer(other) if e["event_type"] == "outcome.asked"]) == 1


def test_the_kill_switch_turns_it_all_off(plugin, ctx, home, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "outcome_ask")
    plugin.register(ctx)
    tenant = Tenant(home)
    tenant.stage()
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    assert tenant.armed() == [] and tenant.stage_file.exists()
    assert plugin._COLLECTOR.outcome_tick() == {}
    # The turn's own message.out still went out.
    assert any(e["event_type"] == "message.out" for e in events(av, plugin))


def test_a_failure_in_the_ask_never_costs_the_message_event(live, ctx, tenant, av, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("Arjun")

    monkeypatch.setattr(module(live), "arm", boom)
    tenant.stage()
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    assert any(e["event_type"] == "message.out" for e in events(av, live))


# -- the answer -----------------------------------------------------------------


@pytest.mark.parametrize("text,value", [
    ("met", "met"), ("Met.", "met"), ("  MET!  ", "met"), ("we met", "met"), ("yes", "met"), ("Yes we met!", "met"),
    ("yep", "met"), ("useful", "useful"), ("Very useful!", "useful"), ("met and useful", "useful"),
    ("not useful", "not_useful"), ("Not useful 👎", "not_useful"), ("met not useful", "not_useful"),
    ("met but not useful", "not_useful"), ("missed", "missed"), ("missed it", "missed"), ("no", "missed"),
    ("Nope.", "missed"), ("not met", "missed"), ("did not meet", "missed"), ("didn't meet", "missed"),
    ("didnt meet", "missed"), ("didn't happen", "did_not_happen"), ("Didn’t happen.", "did_not_happen"),
    ("did not happen", "did_not_happen"),
])
def test_an_answer_from_the_list_emits_outcome_reported_with_the_right_ids(live, ctx, tenant, av, text, value):
    ask_delivered(live, ctx, tenant)
    [asked] = events(av, live, "outcome.asked")
    resident_says(ctx, text)
    assert live._COLLECTOR.outcome_tick().get("answered") == 1
    [reported] = events(av, live, "outcome.reported")
    assert reported["payload"] == {"value": value, "matcher_version": "outcome_reply_v2"}
    assert reported["evidence_class"] == "self_report"
    assert reported["actor"] == "participant"
    assert reported["outcome_id"] == OUTCOME and reported["opportunity_id"] == OPP
    assert reported["in_reply_to_event_id"] == asked["event_id"]
    assert reported["session_id"] == "tg1"
    assert "content_hash" not in reported["payload"] and "message_hash" not in reported["payload"]


def test_an_answer_is_noted_in_memory_only_with_the_value_and_the_time(live, ctx, tenant):
    tenant.stage()
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    resident_says(ctx, "Met.")
    [note] = notes(live)
    assert set(note) == {"id", "value", "at_epoch", "session_id", "turn_id", "seq", "pointer"}
    assert note["value"] == "met" and note["pointer"] is False
    assert not (tenant.state / "outcome-ask" / "answers").exists()


def test_while_an_ask_is_open_every_resident_message_is_noted_as_a_time_only(live, ctx, tenant):
    mod = module(live)
    resident_says(ctx, "hello there")  # no ask open: nothing noted
    assert mod._MESSAGES == []
    tenant.stage()
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    resident_says(ctx, "what's on tomorrow at the Arjun talk?")
    resident_says(ctx, "met")
    assert [type(seq) for seq, _ in mod._MESSAGES] == [int, int]
    assert all(isinstance(at, float) for _, at in mod._MESSAGES)
    assert "Arjun" not in repr(mod._MESSAGES) and "tomorrow" not in repr(mod._MESSAGES)


# -- F4: the answer is the resident's next message after the ask -----------------


def test_a_match_after_other_messages_is_not_the_answer(live, ctx, tenant, av):
    """Three unrelated turns, then `useful` answering something else hours later."""
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, "thanks! what's on tomorrow?")
    resident_says(ctx, "ok book me for the 10am talk")
    resident_says(ctx, "useful")
    assert live._COLLECTOR.outcome_tick().get("answer_not_next") == 1
    assert events(av, live, "outcome.reported") == []


def test_a_match_after_other_messages_counts_when_it_replies_to_the_question(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, "thanks! what's on tomorrow?")
    resident_says(ctx, f'[Replying to your previous message: "{QUESTION}"]\n\nuseful')
    assert live._COLLECTOR.outcome_tick().get("answered") == 1
    [reported] = events(av, live, "outcome.reported")
    assert reported["payload"]["value"] == "useful" and reported["outcome_id"] == OUTCOME


def test_a_message_before_the_delivery_does_not_stop_the_next_one_counting(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    resident_says(ctx, "good evening")  # before Hermes delivered the question
    time.sleep(0.01)
    tenant.finish(execution)
    time.sleep(0.01)
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    assert [e["payload"]["value"] for e in events(av, live, "outcome.reported")] == ["met"]


def test_a_second_match_is_not_the_next_message_even_unanswered(live, ctx, tenant, av):
    """`hi`, then `met`: the first message after the ask was not an answer, so nothing counts."""
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, "hi")
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_a_message_time_dropped_from_memory_means_no_plain_answer_counts(live, ctx, tenant, av, monkeypatch):
    mod = module(live)
    monkeypatch.setattr(mod, "MAX_MESSAGES", 2)
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, "met")  # the next message...
    resident_says(ctx, "a")
    resident_says(ctx, "b")    # ...whose time then drops out of memory, with what came after the ask
    assert mod._MESSAGES_FLOOR > 0
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


# -- F5: an answer belongs to the latest ask DELIVERED before it -----------------


@pytest.mark.parametrize("armed_before_the_answer", [False, True])
def test_an_answer_during_the_next_evenings_run_stays_with_the_ask_the_resident_saw(live, ctx, tenant, av, armed_before_the_answer):
    """Tonight's run is claimed (and maybe armed) but not yet delivered when
    the resident answers yesterday's question: the answer is yesterday's."""
    ask_delivered(live, ctx, tenant)
    [older] = events(av, live, "outcome.asked")
    tonight = uuid.uuid4().hex
    tenant.stage(subjects=SECOND)
    tenant.start(tonight)  # claimed 30 s ago, running
    if armed_before_the_answer:
        evening_reply(ctx, tenant, tonight, start=False)
    time.sleep(0.01)
    resident_says(ctx, "met")
    time.sleep(0.01)
    if not armed_before_the_answer:
        evening_reply(ctx, tenant, tonight, start=False)
    tenant.finish(tonight)  # delivered after the answer
    live._COLLECTOR.outcome_tick()
    assert len(events(av, live, "outcome.asked")) == 2
    [reported] = events(av, live, "outcome.reported")
    assert reported["in_reply_to_event_id"] == older["event_id"]
    assert reported["outcome_id"] == OUTCOME


def test_a_telegram_reply_pointer_is_not_part_of_the_message(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, f'[Replying to your previous message: "{QUESTION}"]\n\nmet')
    live._COLLECTOR.outcome_tick()
    assert [e["payload"]["value"] for e in events(av, live, "outcome.reported")] == ["met"]


def test_a_reply_to_the_question_as_hermes_wraps_its_delivery_counts(live, ctx, tenant, av):
    """The pointer quotes the Telegram text, which may carry Hermes's cron header."""
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, f'[Replying to your previous message: "Cronjob Response: Edge — evening questions\n\n{QUESTION}"]\n\nmissed')
    live._COLLECTOR.outcome_tick()
    assert [e["payload"]["value"] for e in events(av, live, "outcome.reported")] == ["missed"]


@pytest.mark.parametrize("text", [
    '[Replying to your previous message: "**People Follow-Up**\n\n👤 *New connections*\n- Maya, say hello"]\n\nmet',
    '[Replying to: "did you meet Ravi at lunch?"]\n\nmet',
    '[Replying to your previous message: "Priya is still waiting to hear from you."]\n\nuseful',
    '[Replying to your previous message: "Did you and Arjun meet?"]\n\nmet',
])
def test_a_reply_to_any_other_message_is_not_an_answer(live, ctx, tenant, av, text):
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, text)
    assert notes(live) == []
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


@pytest.mark.parametrize("text", [
    "met, and it was great", "met Arjun", "not useful at all", "maybe", "met ok", "met?", "Met? Not sure",
    "> met", '"met"', "“met”", "'met'", "met\n\nthanks", "met, not useful, or missed", "Met. Not useful.",
    "we  met", "yes, we met", "yeah", "didnt happen", "not really", "मिले", "met met",
])
def test_anything_but_the_whole_message_from_the_list_emits_nothing(live, ctx, tenant, av, text):
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, text)
    assert notes(live) == []
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_an_answer_after_24_hours_emits_nothing(live, ctx, tenant, av):
    mod = module(live)
    collector = live._COLLECTOR
    execution = uuid.uuid4().hex
    then = time.time() - 25 * 3600
    tenant.start(execution, at=then - 30)
    tenant.stage(at=then - 5)
    assert mod.arm(collector.config.state_dir, str(tenant.home), session_id=None, task_id=f"cron:{JOB}:{execution}",
                   reply=QUESTION, hasher=collector.keyed_hash, capture="sanitized", now=then) == "armed"
    tenant.finish(execution, at=then + 5)
    collector.outcome_tick()
    assert len(events(av, live, "outcome.asked")) == 1
    resident_says(ctx, "met")
    assert collector.outcome_tick().get("answer_not_counted") == 1
    assert events(av, live, "outcome.reported") == []


SECOND = [{"outcome_id": "opp-outcome:second", "opportunity_id": "second"}]


def test_an_answer_after_a_newer_ask_never_counts_for_the_older_one(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    older = events(av, live, "outcome.asked")[0]["event_id"]
    time.sleep(0.01)
    ask_delivered(live, ctx, tenant, subjects=SECOND)
    newer = [e for e in events(av, live, "outcome.asked") if e["opportunity_id"] == "second"][0]["event_id"]
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    [reported] = events(av, live, "outcome.reported")
    assert reported["in_reply_to_event_id"] == newer != older
    assert reported["opportunity_id"] == "second"


def test_an_answer_noted_before_a_newer_ask_still_counts_for_its_own(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    older = events(av, live, "outcome.asked")[0]["event_id"]
    resident_says(ctx, "missed")
    time.sleep(0.05)
    newer_execution = uuid.uuid4().hex
    tenant.stage(subjects=SECOND)
    tenant.start(newer_execution, at=time.time() - 0.02)
    evening_reply(ctx, tenant, newer_execution, start=False)
    tenant.finish(newer_execution)
    live._COLLECTOR.outcome_tick()
    [reported] = events(av, live, "outcome.reported")
    assert reported["in_reply_to_event_id"] == older
    assert reported["payload"]["value"] == "missed"


def test_an_answer_when_no_ask_is_open_emits_nothing(live, ctx, tenant, av):
    resident_says(ctx, "met")
    assert notes(live) == []
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_a_second_answer_to_the_same_ask_emits_nothing(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    resident_says(ctx, "not useful")
    live._COLLECTOR.outcome_tick()
    assert [e["payload"]["value"] for e in events(av, live, "outcome.reported")] == ["met"]


def test_after_a_restart_a_second_answer_reuses_the_first_ones_event_id(live, ctx, tenant, av):
    """The answer's id is derived from the ask, so ingest keeps one answer per ask."""
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    module(live).reset_memory()
    resident_says(ctx, "not useful")
    live._COLLECTOR.outcome_tick()
    first, second = events(av, live, "outcome.reported")
    assert first["event_id"] == second["event_id"]


def test_an_answer_before_the_delivery_is_confirmed_waits_for_it(live, ctx, tenant, av):
    """Hermes delivered, then the resident answered, and only then did the
    ledger row turn terminal (its finish is the delivery time)."""
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    time.sleep(0.01)
    delivered = time.time()
    time.sleep(0.01)
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []
    assert len(notes(live)) == 1  # waiting
    tenant.finish(execution, at=delivered)
    live._COLLECTOR.outcome_tick()
    [asked] = events(av, live, "outcome.asked")
    [reported] = events(av, live, "outcome.reported")
    assert reported["in_reply_to_event_id"] == asked["event_id"]


def test_a_message_sent_before_the_ask_was_delivered_is_not_its_answer(live, ctx, tenant, av):
    """F5: compared by delivery time (the ledger's finish), not by when the run started."""
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    resident_says(ctx, "met")
    time.sleep(0.01)
    tenant.finish(execution)  # delivered after the message
    assert live._COLLECTOR.outcome_tick().get("answer_no_ask") == 1
    assert len(events(av, live, "outcome.asked")) == 1
    assert events(av, live, "outcome.reported") == []


def test_an_answer_to_an_ask_that_was_never_delivered_emits_nothing(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    resident_says(ctx, "met")
    tenant.finish(execution, delivery="failed")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == [] and events(av, live, "outcome.reported") == []
    assert notes(live) == []


@pytest.mark.parametrize("chat_type", ["group", "channel", "thread", ""])
def test_a_message_in_a_group_chat_emits_nothing(live, ctx, tenant, av, monkeypatch, chat_type):
    ask_delivered(live, ctx, tenant)
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    resident_says(ctx, "met")
    assert notes(live) == []


def test_another_session_kind_emits_nothing(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    ctx.fire("on_session_start", session_id="cli1", model="m", platform="cli")
    resident_says(ctx, "met", session="cli1", platform="cli")
    ctx.fire("subagent_start", parent_session_id="tg1", child_session_id="sub1")
    resident_says(ctx, "met", session="sub1")
    resident_says(ctx, "met", history=[{"role": "user", "content": "met", "display_kind": "internal_notification"}])
    assert notes(live) == []
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_metadata_capture_notes_no_answer(plugin, ctx, home, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="tg1", model="m", platform="telegram")
    tenant = Tenant(home)
    ask_delivered(plugin, ctx, tenant)
    resident_says(ctx, "met")
    assert notes(plugin) == []


def test_the_matcher_table(plugin):
    mod = module(plugin)
    assert mod.MATCHER_VERSION == "outcome_reply_v2"
    # The registered `outcome.reported@1` values (agentvillage-data src/schemas/index.ts).
    assert set(mod.ANSWERS.values()) == {"met", "useful", "not_useful", "missed", "did_not_happen"}
    assert {k for k in mod.ANSWERS if "’" not in k} == {
        "met", "we met", "yes", "yes we met", "yep", "useful", "very useful", "met and useful", "not useful",
        "met not useful", "met but not useful", "missed", "missed it", "no", "nope", "not met", "did not meet",
        "didn't meet", "didnt meet", "didn't happen", "did not happen",
    }
    assert mod.answer_value("MET") == "met"
    assert mod.answer_value("met 👍🏽") == "met"
    assert mod.answer_value("Met!!") == "met"
    assert mod.answer_value("didn’t meet") == "missed"
    assert mod.answer_value("met met") is None
    assert mod.answer_value(None) is None
    # Only trailing marks are stripped: a leading one, or one inside, is part of the message.
    assert mod.answer_value("!met") is None
    assert mod.answer_value("met. useful") is None


# -- flag: "integrity / trust boundary (forged stage file)" --------------------


FORGED_STAGES = {
    "an unknown key": dict(evidence_class="operator_verified"),
    "two subjects": dict(subjects=[{"outcome_id": OUTCOME, "opportunity_id": OPP}, {"outcome_id": "opp-outcome:x", "opportunity_id": "x"}]),
    "an outcome id that is not the opportunity's": dict(subjects=[{"outcome_id": "opp-outcome:other", "opportunity_id": OPP}]),
    "a subject with an extra key": dict(subjects=[{"outcome_id": OUTCOME, "opportunity_id": OPP, "actor": "operator"}]),
    "an id that is not an id": dict(subjects=[{"outcome_id": "opp-outcome:a b", "opportunity_id": "a b"}]),
    "another asker": dict(asked_by="operator"),
    "another window": dict(window_days=7),
    "a boolean window": dict(window_days=True),
    "another version": dict(v=2),
    "another action": dict(action="brief"),
    "a date that is not the stamp's": dict(date="2020-01-01"),
    "a stamp that is not a time": dict(staged_at="soon"),
}


@pytest.mark.parametrize("label", sorted(FORGED_STAGES))
def test_forged_stage_file_with_a_bad_field_is_refused_and_removed(live, ctx, tenant, av, label):
    tenant.write_private(tenant.stage_file, tenant.stage_body(**FORGED_STAGES[label]))
    execution = uuid.uuid4().hex
    evening_reply(ctx, tenant, execution)
    assert not tenant.stage_file.exists(), label
    assert tenant.armed() == []
    tenant.finish(execution)
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == []


def test_forged_stage_file_too_big_is_refused(live, ctx, tenant, av):
    tenant.write_private(tenant.stage_file, json.dumps(tenant.stage_body()) + " " * 4000)
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    assert not tenant.stage_file.exists() and tenant.armed() == []


def test_forged_stage_file_as_a_symlink_is_refused_and_never_followed(live, ctx, tenant, home):
    target = home / "elsewhere.json"
    target.write_text(json.dumps(tenant.stage_body()))
    os.chmod(target, 0o600)
    tenant.stage_file.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(target, tenant.stage_file)
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    assert not os.path.lexists(tenant.stage_file)
    assert target.exists()
    assert tenant.armed() == []


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o606])
def test_forged_stage_file_readable_or_writable_by_others_is_refused(live, ctx, tenant, mode):
    tenant.stage()
    os.chmod(tenant.stage_file, mode)
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    assert not tenant.stage_file.exists() and tenant.armed() == []


def test_forged_stage_file_in_a_directory_others_can_write_is_refused(live, ctx, tenant):
    tenant.stage()
    os.chmod(tenant.stage_file.parent, 0o777)
    try:
        evening_reply(ctx, tenant, uuid.uuid4().hex)
        assert tenant.armed() == []
    finally:
        os.chmod(tenant.stage_file.parent, 0o700)


def test_forged_stage_file_older_than_the_job_run_is_refused(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.start(execution, at=time.time() - 10)
    tenant.stage(at=time.time() - 60)  # written before Hermes claimed the run
    evening_reply(ctx, tenant, execution, start=False)
    assert not tenant.stage_file.exists() and tenant.armed() == []


def test_forged_stage_file_newer_than_the_reply_is_refused(live, ctx, tenant):
    tenant.stage(at=time.time() + 60)
    evening_reply(ctx, tenant, uuid.uuid4().hex)
    assert not tenant.stage_file.exists() and tenant.armed() == []


def test_forged_stage_file_for_a_run_hermes_never_recorded_is_refused(live, ctx, tenant):
    tenant.stage()
    evening_reply(ctx, tenant, uuid.uuid4().hex, start=False)
    assert not tenant.stage_file.exists() and tenant.armed() == []


def test_forged_stage_file_for_a_run_of_another_job_is_refused(live, ctx, tenant):
    """The task id says the evening job; Hermes's own row says another."""
    execution = uuid.uuid4().hex
    tenant.start(execution, job=OTHER_JOB)
    tenant.stage()
    evening_reply(ctx, tenant, execution, start=False)
    assert not tenant.stage_file.exists() and tenant.armed() == []


# -- flag: "integrity / trust boundary" (armed files, asks, answers) -------------


def forged_armed(tenant, execution: str, *, job: str = JOB, staged: float | None = None, armed: float | None = None,
                 subject=None, name: str | None = None, **extra) -> None:
    now = time.time()
    body = {
        "v": 1, "execution_id": execution, "job_id": job, "session_id": None,
        "staged_epoch": now - 20 if staged is None else staged, "armed_epoch": now - 10 if armed is None else armed,
        "message_hash": "0" * 64, "subject": subject or {"outcome_id": "opp-outcome:forged", "opportunity_id": "forged"},
    }
    body.update(extra)
    tenant.armed_dir.mkdir(parents=True, exist_ok=True)
    tenant.write_private(tenant.armed_dir / (name or f"{execution}.json"), body)


def test_a_forged_armed_file_for_another_jobs_delivered_run_emits_nothing(live, tenant, av):
    execution = uuid.uuid4().hex
    tenant.finish(execution, job=OTHER_JOB)
    forged_armed(tenant, execution, job=OTHER_JOB)
    assert live._COLLECTOR.outcome_tick().get("armed_refused") == 1
    assert events(av, live, "outcome.asked") == [] and tenant.armed() == []


def test_a_forged_armed_file_claiming_the_evening_job_for_another_jobs_run_emits_nothing(live, tenant, av):
    execution = uuid.uuid4().hex
    tenant.finish(execution, job=OTHER_JOB)
    forged_armed(tenant, execution, job=JOB)
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == []


def test_a_forged_armed_file_for_an_evening_run_this_process_saw_arm_nothing_emits_nothing(live, ctx, tenant, av):
    """A reminder evening (no stage): the plugin saw the reply and armed nothing."""
    execution = uuid.uuid4().hex
    evening_reply(ctx, tenant, execution, "Pending Person is still waiting to hear from you.")
    forged_armed(tenant, execution)
    tenant.finish(execution)
    assert live._COLLECTOR.outcome_tick().get("armed_tampered") == 1
    assert events(av, live, "outcome.asked") == []


def test_an_armed_file_altered_after_arming_emits_nothing(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, tenant, execution)
    path = tenant.armed_dir / f"{execution}.json"
    body = json.loads(path.read_text())
    body["subject"] = {"outcome_id": "opp-outcome:forged", "opportunity_id": "forged"}
    tenant.write_private(path, body)
    tenant.finish(execution)
    assert live._COLLECTOR.outcome_tick().get("armed_tampered") == 1
    assert events(av, live, "outcome.asked") == []


#: Each forged armed file, built from the finish the test writes (`end`). No
#: value here is computed when pytest collects the file: a time taken then is
#: stale by the time the test runs, and the case would pass or fail by when it ran.
FORGED_ARMED = {
    # The run was claimed at end - 40 (`Tenant.finish`).
    "staged before the run": lambda end: dict(staged=end - 3600, armed=end - 5),
    # After the finish by more than the clock slack, and still not in the future.
    "armed after the run ended": lambda end: dict(staged=end - 20, armed=end + 5),
    "an unknown key": lambda end: dict(staged=end - 20, armed=end - 5, evidence_class="operator_verified"),
    "a hash that is not a hash": lambda end: dict(staged=end - 20, armed=end - 5, message_hash="Did you and Arjun meet?"),
    "a session of another job": lambda end: dict(staged=end - 20, armed=end - 5, session_id=f"cron_{OTHER_JOB}_20261014_190000"),
    "a file named for another execution": lambda end: dict(staged=end - 20, armed=end - 5, name=f"{'f' * 32}.json"),
}


@pytest.mark.parametrize("label", sorted(FORGED_ARMED))
def test_after_a_restart_a_forged_armed_file_outside_what_hermes_recorded_emits_nothing(live, tenant, av, label):
    execution = uuid.uuid4().hex
    end = time.time() - 10
    tenant.finish(execution, at=end)
    forged_armed(tenant, execution, **FORGED_ARMED[label](end))
    codes = live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == [], label
    assert codes.get("armed_refused") == 1, (label, codes)
    assert tenant.armed() == []


def test_the_forged_armed_cases_are_well_formed_but_for_the_one_fault(live, tenant, av):
    """The control for the cases above: the same file without its fault is
    accepted, so each case is refused for its own fault and not for a time
    that went stale."""
    execution = uuid.uuid4().hex
    end = time.time() - 10
    tenant.finish(execution, at=end)
    forged_armed(tenant, execution, staged=end - 20, armed=end - 5)
    assert live._COLLECTOR.outcome_tick().get("asked") == 1


def test_a_forged_armed_file_as_a_symlink_or_shared_emits_nothing(live, tenant, av, home):
    first, second = uuid.uuid4().hex, uuid.uuid4().hex
    tenant.finish(first)
    tenant.finish(second)
    target = home / "armed-target.json"
    forged_armed(tenant, first)
    os.replace(tenant.armed_dir / f"{first}.json", target)
    os.symlink(target, tenant.armed_dir / f"{first}.json")
    forged_armed(tenant, second)
    os.chmod(tenant.armed_dir / f"{second}.json", 0o644)
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == [] and tenant.armed() == []


def test_a_forged_armed_file_cannot_ask_twice_for_one_run(live, ctx, tenant, av):
    execution = ask_delivered(live, ctx, tenant)
    forged_armed(tenant, execution, staged=time.time() - 20, armed=time.time() - 10)
    module(live).reset_memory()
    live._COLLECTOR.outcome_tick()
    assert len(events(av, live, "outcome.asked")) == 1


def test_accepted_limit_after_a_restart_a_well_formed_armed_file_names_the_subject_and_it_stays_plugin_asserted(live, ctx, tenant, av):
    """What remains file-asserted: the subject of a real, delivered evening
    run armed in another process. The ask stays `agent_report`; an answer to
    it stays `self_report` from the participant, never anything verified."""
    execution = uuid.uuid4().hex
    tenant.finish(execution, at=time.time() - 2)
    forged_armed(tenant, execution, staged=time.time() - 38, armed=time.time() - 5)
    live._COLLECTOR.outcome_tick()
    [asked] = events(av, live, "outcome.asked")
    assert asked["opportunity_id"] == "forged" and asked["evidence_class"] == "agent_report" and asked["actor"] == "agent"
    resident_says(ctx, "useful")
    live._COLLECTOR.outcome_tick()
    [reported] = events(av, live, "outcome.reported")
    assert (reported["evidence_class"], reported["actor"], reported["event_type"]) == ("self_report", "participant", "outcome.reported")


def test_a_forged_answer_file_is_never_an_answer(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    answers = tenant.state / "outcome-ask" / "answers"
    answers.mkdir(parents=True, exist_ok=True)
    tenant.write_private(answers / f"{uuid.uuid4()}.json", {"v": 1, "value": "met", "at_epoch": time.time(), "session_id": "tg1", "turn_id": None})
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def write_asks(tenant, *entries) -> None:
    tenant.write_private(tenant.state / "outcome-ask" / "asks.json", {"v": 1, "asks": list(entries)})


def test_a_forged_ask_on_file_for_another_jobs_run_takes_no_answer(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.finish(execution, job=OTHER_JOB)
    write_asks(tenant, {"execution_id": execution, "outcome_id": "opp-outcome:forged", "opportunity_id": "forged"})
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_a_forged_ask_on_file_for_an_undelivered_evening_run_takes_no_answer(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.finish(execution, delivery="failed")
    write_asks(tenant, {"execution_id": execution, "outcome_id": "opp-outcome:forged", "opportunity_id": "forged"})
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_a_forged_ask_on_file_with_extra_keys_is_refused(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.finish(execution)
    write_asks(tenant, {"execution_id": execution, "outcome_id": OUTCOME, "opportunity_id": OPP, "evidence_class": "operator_verified"})
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_a_forged_switch_of_an_asks_subject_on_file_takes_no_answer(live, ctx, tenant, av):
    execution = ask_delivered(live, ctx, tenant)
    write_asks(tenant, {"execution_id": execution, "outcome_id": "opp-outcome:forged", "opportunity_id": "forged"})
    resident_says(ctx, "met")
    codes = live._COLLECTOR.outcome_tick()
    assert codes.get("ask_tampered") == 1
    assert events(av, live, "outcome.reported") == []


def test_a_forged_asks_file_that_is_a_symlink_is_refused(live, ctx, tenant, av, home):
    execution = uuid.uuid4().hex
    tenant.finish(execution)
    target = home / "asks-target.json"
    target.write_text(json.dumps({"v": 1, "asks": [{"execution_id": execution, "outcome_id": OUTCOME, "opportunity_id": OPP}]}))
    os.chmod(target, 0o600)
    (tenant.state / "outcome-ask").mkdir(parents=True, exist_ok=True)
    os.symlink(target, tenant.state / "outcome-ask" / "asks.json")
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []
    assert target.exists()
