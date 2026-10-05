"""DATA-42 (ruling R2): the evening outcome ask, the plugin's half (`_outcome_ask`).

The trigger's half (the pick, the stage file, the prompts) is
`skills/index-network/scripts/tests/outcome-ask.test.ts`.
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
    return datetime.fromtimestamp(epoch, timezone.utc).astimezone(IST).isoformat()


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

    def stage(self, *, at: float | None = None, subjects=None) -> None:
        self.stage_file.parent.mkdir(parents=True, exist_ok=True)
        staged = datetime.fromtimestamp(time.time() if at is None else at, timezone.utc).isoformat().replace("+00:00", "Z")
        self.stage_file.write_text(json.dumps({
            "v": 1, "action": "evening", "date": "2026-10-14", "staged_at": staged, "asked_by": "outcome_cron",
            "window_days": 1, "subjects": subjects or [{"outcome_id": OUTCOME, "opportunity_id": OPP}],
        }))

    def finish(self, execution: str, *, at: float | None = None, status: str = "completed", delivery: str | None = "delivered", job: str = JOB) -> None:
        end = time.time() if at is None else at
        values = [execution, job, "tick", "p", 1, None, status, stamp(end - 40), stamp(end - 30), stamp(end), None]
        if self.delivery_column:
            values.append(delivery)
        with sqlite3.connect(self.cron / "executions.db") as conn:
            conn.execute(f"INSERT INTO executions VALUES ({','.join('?' * len(values))})", values)

    def asked_ledger(self) -> dict:
        path = self.state / "proactive" / "outcome-asked.json"
        return json.loads(path.read_text())["asked"] if path.exists() else {}

    def armed(self) -> list[str]:
        path = self.state / "outcome-ask" / "armed"
        return sorted(os.listdir(path)) if path.exists() else []

    def notes(self) -> list[str]:
        path = self.state / "outcome-ask" / "answers"
        return sorted(os.listdir(path)) if path.exists() else []


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


def evening_reply(ctx, execution: str, text: str = QUESTION, job: str = JOB) -> None:
    session = f"cron_{job}_20261014_190000"
    ctx.fire("on_session_start", session_id=session, model="m", platform="cron")
    ctx.fire("post_llm_call", session_id=session, task_id=f"cron:{job}:{execution}", turn_id="t1",
             user_message="the job prompt", assistant_response=text, model="m", platform="cron", conversation_history=[])


def resident_says(ctx, text: str, *, session: str = "tg1", platform: str = "telegram", history=None) -> None:
    ctx.fire("pre_llm_call", session_id=session, task_id=session, turn_id=f"turn-{uuid.uuid4().hex[:8]}", user_message=text,
             platform=platform, model="m", conversation_history=history if history is not None else [{"role": "user", "content": text}])


def ask_delivered(live, ctx, tenant, *, execution=None, delivery="delivered") -> str:
    execution = execution or uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, execution)
    tenant.finish(execution, delivery=delivery)
    live._COLLECTOR.outcome_tick()
    return execution


# -- the ask ------------------------------------------------------------------


@pytest.mark.parametrize("delivery", ["delivered", "queued"])
def test_the_ask_is_emitted_only_once_delivered_or_queued(live, ctx, tenant, av, delivery):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, execution)
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


def test_nothing_on_silent(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, execution, "[SILENT]")
    assert not tenant.stage_file.exists()
    assert tenant.armed() == []
    tenant.finish(execution, delivery="suppressed")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == []
    assert tenant.asked_ledger() == {}


@pytest.mark.parametrize("status,delivery", [("completed", "failed"), ("completed", "suppressed"), ("completed", "not_configured"),
                                             ("completed", None), ("failed", "delivered"), ("unknown", None)])
def test_nothing_on_failed_delivery_and_the_subject_stays_due(live, ctx, tenant, av, status, delivery):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, execution)
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
    evening_reply(ctx, execution)
    tenant.finish(execution)
    plugin._COLLECTOR.outcome_tick()
    assert len(events(av, plugin, "outcome.asked")) == 1


def test_a_stale_stage_file_is_ignored_and_removed(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage(at=time.time() - 20 * 60)
    evening_reply(ctx, execution)
    assert not tenant.stage_file.exists()
    assert tenant.armed() == []
    # The tick sweeps one no run ever reached, too.
    tenant.stage(at=time.time() - 16 * 60)
    live._COLLECTOR.outcome_tick()
    assert not tenant.stage_file.exists()
    tenant.finish(execution)
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == []


def test_a_stage_from_the_future_is_stale(live, ctx, tenant):
    tenant.stage(at=time.time() + 600)
    evening_reply(ctx, uuid.uuid4().hex)
    assert not tenant.stage_file.exists() and tenant.armed() == []


def test_two_runs_racing_for_one_stage_arm_it_once(live, tenant):
    mod = module(live)
    collector = live._COLLECTOR
    tenant.stage()
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
    evening_reply(ctx, uuid.uuid4().hex)
    assert tenant.stage_file.exists() and tenant.armed() == []
    # Another installer job (the brief) never arms either.
    evening_reply(ctx, uuid.uuid4().hex, job=OTHER_JOB)
    assert tenant.stage_file.exists() and tenant.armed() == []


def test_cron_sessions_are_handled_explicitly(live, ctx, tenant, av):
    """A cron run's reply arms (from `post_llm_call`), its prompt is never an
    answer (from `pre_llm_call`), and a chat turn never arms."""
    tenant.stage()
    session = f"cron_{JOB}_20261014_190000"
    ctx.fire("pre_llm_call", session_id=session, task_id=f"cron:{JOB}:{'c' * 32}", user_message="met", platform="cron",
             model="m", conversation_history=[{"role": "user", "content": "met"}])
    assert tenant.notes() == []
    ctx.fire("post_llm_call", session_id="tg1", task_id=f"cron:{JOB}:{'c' * 32}", assistant_response=QUESTION, platform="telegram")
    assert tenant.armed() == [] and tenant.stage_file.exists()
    evening_reply(ctx, "c" * 32)
    assert tenant.armed() == [f"{'c' * 32}.json"]


def test_metadata_capture_sends_the_ask_without_a_hash(plugin, ctx, home, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "metadata")
    plugin.register(ctx)
    tenant = Tenant(home)
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, execution)
    tenant.finish(execution)
    plugin._COLLECTOR.outcome_tick()
    [asked] = events(av, plugin, "outcome.asked")
    assert asked["payload"]["message_hash"] is None


def test_an_armed_run_survives_a_restart(live, ctx, tenant, av, plugin):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, execution)
    tenant.finish(execution)
    # A different collector (the next process) finishes it.
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
    evening_reply(ctx, uuid.uuid4().hex)
    assert tenant.armed() == [] and tenant.stage_file.exists()
    assert plugin._COLLECTOR.outcome_tick() == {}
    # The turn's own message.out still went out.
    assert any(e["event_type"] == "message.out" for e in events(av, plugin))


def test_a_failure_in_the_ask_never_costs_the_message_event(live, ctx, tenant, av, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("Arjun")

    monkeypatch.setattr(module(live), "arm", boom)
    tenant.stage()
    evening_reply(ctx, uuid.uuid4().hex)
    assert any(e["event_type"] == "message.out" for e in events(av, live))


# -- the answer -----------------------------------------------------------------


@pytest.mark.parametrize("text,value", [
    ("met", "met"), ("Met.", "met"), ("  MET!  ", "met"), ("we met", "met"), ("useful", "useful"),
    ("not useful", "not_useful"), ("Not useful 👎", "not_useful"), ("missed", "missed"),
    ("didn't happen", "did_not_happen"), ("Didn’t happen.", "did_not_happen"), ("did not happen", "did_not_happen"),
])
def test_an_answer_from_the_list_emits_outcome_reported_with_the_right_ids(live, ctx, tenant, av, text, value):
    ask_delivered(live, ctx, tenant)
    [asked] = events(av, live, "outcome.asked")
    resident_says(ctx, text)
    assert live._COLLECTOR.outcome_tick().get("answered") == 1
    [reported] = events(av, live, "outcome.reported")
    assert reported["payload"] == {"value": value, "matcher_version": "outcome_reply_v1"}
    assert reported["evidence_class"] == "self_report"
    assert reported["actor"] == "participant"
    assert reported["outcome_id"] == OUTCOME and reported["opportunity_id"] == OPP
    assert reported["in_reply_to_event_id"] == asked["event_id"]
    assert reported["session_id"] == "tg1"
    # No text and no hash of the reply.
    assert text.strip() not in json.dumps(reported["payload"]) or text.strip().lower() == value
    assert "content_hash" not in reported["payload"] and "message_hash" not in reported["payload"]


def test_the_answer_note_holds_only_the_value_and_the_time(live, ctx, tenant):
    tenant.stage()
    evening_reply(ctx, uuid.uuid4().hex)
    resident_says(ctx, "Met.")
    [name] = tenant.notes()
    note = json.loads((tenant.state / "outcome-ask" / "answers" / name).read_text())
    assert set(note) == {"v", "value", "at_epoch", "session_id", "turn_id"}
    assert note["value"] == "met"


def test_a_telegram_reply_pointer_is_not_part_of_the_message(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, f'[Replying to your previous message: "{QUESTION}"]\n\nmet')
    live._COLLECTOR.outcome_tick()
    assert [e["payload"]["value"] for e in events(av, live, "outcome.reported")] == ["met"]


@pytest.mark.parametrize("text", ["met, and it was great", "yes we met", "met Arjun", "not useful at all", "maybe", "met?"[:-1] + " ok"])
def test_anything_but_the_whole_message_from_the_list_emits_nothing(live, ctx, tenant, av, text):
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, text)
    assert tenant.notes() == []
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_an_answer_after_24_hours_emits_nothing(live, ctx, tenant, av):
    mod = module(live)
    collector = live._COLLECTOR
    execution = uuid.uuid4().hex
    then = time.time() - 25 * 3600
    tenant.stage(at=then)
    assert mod.arm(collector.config.state_dir, str(tenant.home), session_id="s", task_id=f"cron:{JOB}:{execution}",
                   reply=QUESTION, hasher=collector.keyed_hash, capture="sanitized", now=then) == "armed"
    tenant.finish(execution, at=then + 5)
    collector.outcome_tick()
    assert len(events(av, live, "outcome.asked")) == 1
    resident_says(ctx, "met")
    assert collector.outcome_tick().get("answer_not_counted") == 1
    assert events(av, live, "outcome.reported") == []


def test_an_answer_after_a_newer_ask_never_counts_for_the_older_one(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    older = events(av, live, "outcome.asked")[0]["event_id"]
    # The older ask answered late, after a newer ask went out: it is the newer one's.
    newer_execution = uuid.uuid4().hex
    tenant.stage(subjects=[{"outcome_id": "opp-outcome:second", "opportunity_id": "second"}])
    evening_reply(ctx, newer_execution)
    tenant.finish(newer_execution)
    live._COLLECTOR.outcome_tick()
    newer = [e for e in events(av, live, "outcome.asked") if e["opportunity_id"] == "second"][0]["event_id"]
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    [reported] = events(av, live, "outcome.reported")
    assert reported["in_reply_to_event_id"] == newer != older
    assert reported["opportunity_id"] == "second"


def test_an_answer_noted_before_a_newer_ask_still_counts_for_its_own(live, ctx, tenant, av):
    """Order does not matter: an answer to the older ask, noted before the
    newer was armed but processed after it was confirmed, is the older's."""
    ask_delivered(live, ctx, tenant)
    older = events(av, live, "outcome.asked")[0]["event_id"]
    resident_says(ctx, "missed")
    time.sleep(0.01)
    newer_execution = uuid.uuid4().hex
    tenant.stage(subjects=[{"outcome_id": "opp-outcome:second", "opportunity_id": "second"}])
    evening_reply(ctx, newer_execution)
    tenant.finish(newer_execution)
    live._COLLECTOR.outcome_tick()
    [reported] = events(av, live, "outcome.reported")
    assert reported["in_reply_to_event_id"] == older
    assert reported["payload"]["value"] == "missed"


def test_an_answer_when_no_ask_is_open_emits_nothing(live, ctx, tenant, av):
    resident_says(ctx, "met")
    assert tenant.notes() == []
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []


def test_a_second_answer_to_the_same_ask_emits_nothing(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    resident_says(ctx, "not useful")
    live._COLLECTOR.outcome_tick()
    assert [e["payload"]["value"] for e in events(av, live, "outcome.reported")] == ["met"]


def test_an_answer_before_the_delivery_is_confirmed_waits_for_it(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, execution)
    resident_says(ctx, "met")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.reported") == []
    tenant.finish(execution)
    live._COLLECTOR.outcome_tick()
    [asked] = events(av, live, "outcome.asked")
    [reported] = events(av, live, "outcome.reported")
    assert reported["in_reply_to_event_id"] == asked["event_id"]


def test_an_answer_to_an_ask_that_was_never_delivered_emits_nothing(live, ctx, tenant, av):
    execution = uuid.uuid4().hex
    tenant.stage()
    evening_reply(ctx, execution)
    resident_says(ctx, "met")
    tenant.finish(execution, delivery="failed")
    live._COLLECTOR.outcome_tick()
    assert events(av, live, "outcome.asked") == [] and events(av, live, "outcome.reported") == []
    assert tenant.notes() == []


@pytest.mark.parametrize("chat_type", ["group", "channel", "thread", ""])
def test_a_message_in_a_group_chat_emits_nothing(live, ctx, tenant, av, monkeypatch, chat_type):
    ask_delivered(live, ctx, tenant)
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", chat_type)
    resident_says(ctx, "met")
    assert tenant.notes() == []


def test_another_session_kind_emits_nothing(live, ctx, tenant, av):
    ask_delivered(live, ctx, tenant)
    # A CLI or desktop chat.
    ctx.fire("on_session_start", session_id="cli1", model="m", platform="cli")
    resident_says(ctx, "met", session="cli1", platform="cli")
    # A subagent's goal.
    ctx.fire("subagent_start", parent_session_id="tg1", child_session_id="sub1")
    resident_says(ctx, "met", session="sub1")
    # A turn Hermes injected into the resident's chat.
    resident_says(ctx, "met", history=[{"role": "user", "content": "met", "display_kind": "internal_notification"}])
    assert tenant.notes() == []
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
    assert tenant.notes() == []


def test_the_matcher_table(plugin):
    mod = module(plugin)
    assert mod.MATCHER_VERSION == "outcome_reply_v1"
    assert set(mod.ANSWERS.values()) == {"met", "useful", "not_useful", "missed", "did_not_happen"}
    assert mod.answer_value("MET") == "met"
    assert mod.answer_value("met met") is None
    assert mod.answer_value(None) is None
