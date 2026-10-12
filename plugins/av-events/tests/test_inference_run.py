"""DATA-470: the memory signal sync's caps, `origin` on `intention.captured`, and
`intention.inference_run@1` (ambient-intent telemetry contract, `_inference_run.py`).

Fixtures are hand-written from the contract (lanes-data/AMBIENT-CONTRACT.md);
regenerate them from the producer's builder at its merge sha.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

REPO = Path(__file__).resolve().parents[3]
GATE = REPO / "skills" / "index-network" / "scripts" / "memory_signal_gate.py"
JOB = "ab12cd34ef56"
OTHER_JOB = "0123456789ab"
CRON_SESSION = f"cron_{JOB}_20261012_010000"
OTHER_CRON = f"cron_{OTHER_JOB}_20261012_020000"
TEXT = "Looking for a hardware cofounder for the seed library"
ID1 = "01920000-0000-7000-8000-000000000001"
INFERRED = "intent.publish.inferred.index"

#: The contract's payload, closed: every key, nothing else.
KEYS = {
    "run_id", "job", "started_at", "finished_at", "exit_branch", "memory_bytes", "resident_messages_since_last_run",
    "stated_goals", "existing_intents", "prior_declines", "candidates_considered", "recorded_intent_id", "model",
    "input_tokens", "output_tokens", "error_code",
}
EXIT_BRANCHES = {"gated_no_change", "no_candidate", "candidate_already_covered", "candidate_previously_declined",
                 "capped", "recorded", "tool_unavailable", "error"}
ERROR_CODES = {"tool_unavailable", "model_error", "model_timeout", "io_error", "state_write_failed", "unknown"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MODEL = re.compile(r"^[a-z0-9][a-z0-9./:_-]{0,63}$")
RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
COUNTS = ("memory_bytes", "resident_messages_since_last_run", "stated_goals", "existing_intents", "prior_declines",
          "candidates_considered", "input_tokens", "output_tokens")


def check_contract(payload: dict) -> None:
    """The contract's rules, as ingest's registration will check them."""
    assert set(payload) == KEYS, set(payload) ^ KEYS
    assert UUID.match(payload["run_id"]) and uuid.UUID(payload["run_id"]).version == 7
    assert payload["job"] == "memory_signal_sync"
    assert RFC3339.match(payload["started_at"]) and RFC3339.match(payload["finished_at"])
    assert payload["exit_branch"] in EXIT_BRANCHES
    for key in COUNTS:
        assert isinstance(payload[key], int) and not isinstance(payload[key], bool) and payload[key] >= 0, key
    assert MODEL.match(payload["model"])
    if payload["exit_branch"] == "recorded":
        assert UUID.match(payload["recorded_intent_id"])
    else:
        assert payload["recorded_intent_id"] is None
    if payload["exit_branch"] in ("error", "tool_unavailable"):
        assert payload["error_code"] in ERROR_CODES
    else:
        assert payload["error_code"] is None


def iso(seconds_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).isoformat()


class Box:
    """A `$HERMES_HOME` with the installed memory signal sync job, its ledger and its files."""

    SCHEMA = """CREATE TABLE executions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT NOT NULL, process_id TEXT NOT NULL,
        pid INTEGER NOT NULL, process_started_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('claimed','running','completed','failed','unknown')),
        claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT)"""

    def __init__(self, home: Path) -> None:
        self.home = home
        (home / "cron").mkdir(parents=True, exist_ok=True)
        (home / "av-events").mkdir(parents=True, exist_ok=True)
        (home / "memory").mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(home / "cron" / "executions.db") as conn:
            conn.execute(self.SCHEMA)
        (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [
            {"id": JOB, "name": "Edge — memory signal sync"}, {"id": OTHER_JOB, "name": "Edge — digest prepare"},
        ]}))
        (home / "av-events" / "installed_jobs.json").write_text(json.dumps({"ids": [JOB, OTHER_JOB]}))

    def execution(self, *, status: str = "completed", ago: float = 60.0, duration: float = 30.0, job: str = JOB) -> str:
        execution_id = uuid.uuid4().hex
        with sqlite3.connect(self.home / "cron" / "executions.db") as conn:
            conn.execute("INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
                execution_id, job, "tick", "p", 1, None, status, iso(ago + duration + 1), iso(ago + duration),
                iso(ago), None if status == "completed" else "Traceback: SECRET-ERROR-TEXT"))
        return execution_id

    def audit(self, *, ago: float = 61.0, prompt: int = 75000, completion: int = 900, model: str = "openai/gpt-6-luna",
              error: Optional[str] = None) -> None:
        ts = (datetime.now(timezone.utc) - timedelta(seconds=ago)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        line = {"ts": ts, "job_id": JOB, "fire_id": uuid.uuid4().hex, "prompt_tokens": prompt, "completion_tokens": completion,
                "total_tokens": prompt + completion, "response_silent": True, "deliver_target": None, "model": model,
                "duration_ms": 30000, "error": error}
        with open(self.home / "cron" / "usage_audit.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line) + "\n")

    def run(self, **fields: Any) -> dict:
        """A gate record (what memory_signal_gate.py appends), started inside the execution window."""
        record = {
            "run_id": str(uuid.UUID(int=(int(time.time() * 1000) << 80) | (0x7 << 76) | (0b10 << 62) | uuid.uuid4().int % (1 << 62))),
            "village_date": datetime.now(timezone(timedelta(hours=5, minutes=30))).date().isoformat(),
            "started_at": iso(85), "finished_at": None, "woke": True, "exit_branch": None, "gate_reason": "evidence",
            "error_code": None, "memory_bytes": 120, "resident_messages_since_last_run": 4, "stated_goals": 2,
            "prior_declines": 1, "existing_intents": None, "candidates_considered": 0, "recorded_intent_id": None,
            "recorded_text": None,
        }
        record.update(fields)
        path = self.home / "av-events" / "memory_signal_runs.json"
        data = json.loads(path.read_text()) if path.exists() else {"v": 1, "runs": []}
        data["runs"].append(record)
        path.write_text(json.dumps(data))
        return record

    def runs(self) -> list[dict]:
        return json.loads((self.home / "av-events" / "memory_signal_runs.json").read_text())["runs"]

    def outcome(self, run_id: str, exit: str, considered: int = 2) -> None:
        (self.home / "memory" / "heartbeat-state.json").write_text(json.dumps({"memorySignals": {
            "lastOutcome": {"runId": run_id, "exit": exit, "candidatesConsidered": considered}}}))

    def approvals(self, *items: tuple[str, str, float, Optional[str]]) -> None:
        """(id, state, updated seconds ago, held hash) inferred proposals in the plugin's map."""
        now = time.time()
        entries = {}
        for intention_id, state, ago, held in items:
            entry: dict[str, Any] = {"published": False, "source": "ambient", "approval": {
                "class": INFERRED, "key": f"{INFERRED}:{intention_id}", "state": state,
                "opened_at": now - ago - 60, "updated_at": now - ago}}
            if held:
                entry["held_norm_hash"] = held
            entries[intention_id] = entry
        (self.home / "av-events" / "intentions.json").write_text(json.dumps({"v": 1, "intentions": entries, "publishes": []}))


@pytest.fixture()
def box(home) -> Box:
    return Box(home)


@pytest.fixture()
def live(plugin, ctx, monkeypatch, box):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", "tenant-0b7d")
    monkeypatch.setenv("AV_INFERENCE_RUN_EVENTS", "1")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    return plugin


def events(av, plugin, kind: str = "intention.inference_run") -> list[dict]:
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == kind]


def tick_one(av, plugin) -> dict:
    plugin._COLLECTOR.cron_tick()
    found = events(av, plugin)
    assert len(found) == 1, found
    check_contract(found[0]["payload"])
    return found[0]


# --------------------------------------------------------------------------
# The event, one per run, every exit branch
# --------------------------------------------------------------------------


def test_a_gated_run_is_reported_with_no_model_and_no_tokens(live, box, av):
    record = box.run(woke=False, exit_branch="gated_no_change", gate_reason="no_evidence", finished_at=iso(84),
                     resident_messages_since_last_run=1)
    execution = box.execution()
    event = tick_one(av, live)
    payload = event["payload"]
    assert payload["exit_branch"] == "gated_no_change"
    assert payload["run_id"] == record["run_id"]
    assert payload["model"] == "none" and payload["input_tokens"] == 0 and payload["output_tokens"] == 0
    assert payload["resident_messages_since_last_run"] == 1 and payload["stated_goals"] == 2
    assert payload["error_code"] is None and payload["recorded_intent_id"] is None
    assert event["schema_version"] == 1 and event["actor"] == "system"
    assert event["run_id"] == f"cron:{JOB}:{execution}"
    assert event["occurred_at"] == payload["finished_at"]
    assert uuid.UUID(event["event_id"]).version == 7
    # cron.run is still there, unchanged.
    assert len(events(av, live, "cron.run")) == 1


@pytest.mark.parametrize("said", ["no_candidate", "candidate_already_covered", "candidate_previously_declined"])
def test_a_woken_run_reports_the_models_outcome_with_its_tokens(live, box, av, said):
    record = box.run(existing_intents=3)
    box.execution()
    box.audit()
    box.outcome(record["run_id"], said, considered=2)
    payload = tick_one(av, live)["payload"]
    assert payload["exit_branch"] == said
    assert payload["candidates_considered"] == 2 and payload["existing_intents"] == 3
    assert payload["model"] == "openai/gpt-6-luna"
    assert payload["input_tokens"] == 75000 and payload["output_tokens"] == 900
    assert payload["error_code"] is None


@pytest.mark.parametrize("exit_branch,code", [("tool_unavailable", "tool_unavailable"), ("error", "io_error")])
def test_a_gate_stop_carries_its_code_from_the_closed_list(live, box, av, exit_branch, code):
    box.run(woke=False, exit_branch=exit_branch, error_code=code, finished_at=iso(84))
    box.execution()
    payload = tick_one(av, live)["payload"]
    assert (payload["exit_branch"], payload["error_code"]) == (exit_branch, code)


def test_a_code_outside_the_closed_list_never_leaves(live, box, av):
    box.run(woke=False, exit_branch="error", error_code="Traceback (most recent call last)", finished_at=iso(84))
    box.execution()
    assert tick_one(av, live)["payload"]["error_code"] == "unknown"


@pytest.mark.parametrize("said,exit_branch,code", [
    ("tool_unavailable", "tool_unavailable", "tool_unavailable"),
    ("error", "error", "unknown"),
    ("recorded", "error", "unknown"),  # the model said so, the tool never confirmed it
    (None, "error", "state_write_failed"),  # no outcome written
])
def test_a_woken_run_without_a_clean_outcome_is_an_error_with_a_listed_code(live, box, av, said, exit_branch, code):
    record = box.run()
    box.execution()
    box.audit()
    if said is not None:
        box.outcome(record["run_id"], said)
    payload = tick_one(av, live)["payload"]
    assert (payload["exit_branch"], payload["error_code"]) == (exit_branch, code)


@pytest.mark.parametrize("error,code", [(None, "model_error"), ("Model call timed out after 600s", "model_timeout")])
def test_a_failed_execution_is_a_model_error_or_timeout_and_never_its_text(live, box, av, error, code):
    record = box.run()
    box.execution(status="failed")
    box.audit(error=error)
    box.outcome(record["run_id"], "no_candidate")
    event = tick_one(av, live)
    assert (event["payload"]["exit_branch"], event["payload"]["error_code"]) == ("error", code)
    assert "SECRET-ERROR-TEXT" not in json.dumps(event) and "timed out" not in json.dumps(event)


def test_an_outcome_for_another_run_is_not_this_runs(live, box, av):
    box.run()
    box.execution()
    box.outcome("01920000-0000-7000-8000-00000000beef", "no_candidate")
    assert tick_one(av, live)["payload"]["error_code"] == "state_write_failed"


def test_no_gate_record_is_an_error_unknown_with_a_derived_run_id(live, box, av):
    box.execution()
    payload = tick_one(av, live)["payload"]
    assert (payload["exit_branch"], payload["error_code"]) == ("error", "unknown")
    assert payload["model"] == "none"


def test_an_unexpected_exception_emits_error_unknown_and_no_message_text(live, box, av, monkeypatch, caplog):
    import sys as _sys

    ir = _sys.modules[f"{live.__name__}._inference_run"]

    def boom(home, execution):
        raise ValueError("SECRET exception message about the resident")

    monkeypatch.setattr(ir, "finalize", boom)
    box.run()
    box.execution()
    box.audit()
    event = tick_one(av, live)
    assert (event["payload"]["exit_branch"], event["payload"]["error_code"]) == ("error", "unknown")
    assert "SECRET" not in json.dumps(event) and "ValueError" not in json.dumps(event)
    assert live._COLLECTOR.inference_errors == 1
    assert all("SECRET" not in r.getMessage() for r in caplog.records)


def test_the_flag_off_emits_nothing_and_still_completes_the_record(plugin, ctx, monkeypatch, box, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.delenv("AV_INFERENCE_RUN_EVENTS", raising=False)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    record = box.run()
    (box.home / "memory" / "memory-signal-inputs.md").write_text("RESIDENT TEXT")
    box.execution()
    box.outcome(record["run_id"], "no_candidate")
    plugin._COLLECTOR.cron_tick()
    assert events(av, plugin) == []
    assert len(events(av, plugin, "cron.run")) == 1
    assert box.runs()[-1]["exit_branch"] == "no_candidate" and box.runs()[-1]["finished_at"]
    # The resident's text does not outlive the run.
    assert not (box.home / "memory" / "memory-signal-inputs.md").exists()


@pytest.mark.parametrize("value", ["0", "off", "", "maybe"])
def test_only_a_truthy_flag_emits(live, box, av, monkeypatch, value):
    monkeypatch.setenv("AV_INFERENCE_RUN_EVENTS", value)
    box.run(woke=False, exit_branch="gated_no_change", finished_at=iso(84))
    box.execution()
    live._COLLECTOR.cron_tick()
    assert events(av, live) == []


def test_the_flag_is_read_from_the_boxs_env_file_too(plugin, ctx, monkeypatch, box, av, home):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.delenv("AV_INFERENCE_RUN_EVENTS", raising=False)
    (home / ".env").write_text("AV_INFERENCE_RUN_EVENTS=1\n")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    box.run(woke=False, exit_branch="gated_no_change", finished_at=iso(84))
    box.execution()
    plugin._COLLECTOR.cron_tick()
    assert len(events(av, plugin)) == 1


def test_inference_run_in_hooks_disabled_stops_the_event(live, box, av, monkeypatch):
    monkeypatch.setenv("AV_HOOKS_DISABLED", "inference_run")
    live._COLLECTOR.reload_config()
    box.run(woke=False, exit_branch="gated_no_change", finished_at=iso(84))
    box.execution()
    live._COLLECTOR.cron_tick()
    assert events(av, live) == [] and len(events(av, live, "cron.run")) == 1


def test_another_job_has_no_inference_run(live, box, av):
    box.run(woke=False, exit_branch="gated_no_change", finished_at=iso(84))
    box.execution(job=OTHER_JOB)
    live._COLLECTOR.cron_tick()
    assert events(av, live) == []


def test_two_processes_derive_the_same_event_id(live, box, av):
    import sys as _sys

    other = _sys.modules[f"{live.__name__}._collector"].Collector()
    other._stop.set()
    other.cron_tick()  # its cursor is loaded now, and never re-read (DATA-185)
    record = box.run()
    box.execution()
    box.outcome(record["run_id"], "no_candidate")
    live._COLLECTOR.cron_tick()
    other.cron_tick()
    ids = [e["event_id"] for e in events(av, live)]
    assert len(ids) == 2 and len(set(ids)) == 1


def test_the_payload_holds_no_text_at_all(live, box, av):
    record = box.run(recorded_text=TEXT, recorded_intent_id=ID1)
    box.execution()
    box.audit()
    box.outcome(record["run_id"], "recorded", considered=1)
    event = tick_one(av, live)
    assert event["payload"]["exit_branch"] == "recorded" and event["payload"]["recorded_intent_id"] == ID1
    assert "seed library" not in json.dumps(event)


# --------------------------------------------------------------------------
# record_intention in the memory signal sync: the caps, the step order, origin
# --------------------------------------------------------------------------


class ToolCtx:
    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.tools: dict[str, dict] = {}

    def register_hook(self, name, callback):  # noqa: ANN001
        self.hooks.setdefault(name, []).append(callback)

    def register_tool(self, name, toolset, schema, handler, **_: Any):  # noqa: ANN001
        self.tools[name] = {"handler": handler}

    def fire(self, name: str, **kwargs: Any) -> None:
        for callback in self.hooks.get(name, []):
            callback(**kwargs)


@pytest.fixture()
def tool(plugin, box, monkeypatch):
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.setenv("INDEX_API_KEY", "ix_test")
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    ctx = ToolCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=CRON_SESSION, model="m", platform="cron")
    ctx.fire("on_session_start", session_id=OTHER_CRON, model="m", platform="cron")
    ctx.fire("on_session_start", session_id="dm", model="m", platform="telegram")
    return ctx


def capture(ctx: ToolCtx, text: str = TEXT, *, session: str = CRON_SESSION) -> dict:
    args = {"text": text, "source": "ambient"}
    result = ctx.tools["record_intention"]["handler"](args, session_id=session, task_id="t")
    ctx.fire("post_tool_call", tool_name="record_intention", args=args, result=result, session_id=session,
             task_id="t", tool_call_id="c1", duration_ms=5, status="error" if '"error"' in result else "ok")
    return json.loads(result)


INTENTS = json.dumps({"result": "Your signals:\n\n" + json.dumps({"success": True, "data": {"intents": [
    {"id": "a", "description": "x", "status": "active"}, {"id": "b", "description": "y", "status": "paused"},
    {"id": "c", "description": "z", "status": "active"}]}})})


def listed(ctx: ToolCtx, *, session: str = CRON_SESSION, name: str = "mcp__index__list_intents", args: Any = None) -> None:
    ctx.fire("post_tool_call", tool_name=name, args=args if args is not None else {"limit": 50}, result=INTENTS,
             session_id=session, task_id="t", tool_call_id="c0", duration_ms=5, status="ok")


def test_record_before_list_intents_is_refused(tool, box):
    box.run()
    out = capture(tool)
    assert out["success"] is False and out["error"] == "intents_not_listed"
    assert box.runs()[-1]["recorded_intent_id"] is None


def test_after_list_intents_one_capture_is_held_and_noted_and_a_second_is_refused(tool, box, av, plugin):
    box.run()
    listed(tool)
    assert box.runs()[-1]["intents_listed"] is True and box.runs()[-1]["existing_intents"] == 2
    out = capture(tool)
    assert out["success"] is True and out["source"] == "ambient" and out["published"] is False
    run = box.runs()[-1]
    assert run["recorded_intent_id"] == out["intention_id"] and run["recorded_text"] == TEXT
    again = capture(tool, "Looking for soil scientists to meet this month")
    assert again["error"] == "pass_limit_reached"
    captured = events(av, plugin, "intention.captured")
    assert len(captured) == 1
    assert captured[0]["payload"]["origin"] == "memory_signal_sync" and captured[0]["payload"]["source"] == "ambient"


def test_list_intents_through_the_tool_call_bridge_counts_too(tool, box):
    box.run()
    listed(tool, name="tool_call", args={"calls": [{"name": "mcp__index__list_intents", "arguments": {}}]})
    assert box.runs()[-1]["intents_listed"] is True
    assert capture(tool)["success"] is True


def test_a_failed_list_does_not_count(tool, box):
    box.run()
    tool.fire("post_tool_call", tool_name="mcp__index__list_intents", args={}, result='{"error": "boom"}',
              session_id=CRON_SESSION, task_id="t", tool_call_id="c0", duration_ms=5, status="error")
    assert capture(tool)["error"] == "intents_not_listed"


def test_one_inferred_intent_a_night(tool, box):
    box.run(recorded_intent_id=ID1, finished_at=iso(4000), started_at=iso(4100))
    box.run()
    listed(tool)
    assert capture(tool)["error"] == "nightly_limit_reached"


def test_none_while_an_inferred_card_is_open(tool, box):
    box.run()
    box.approvals((ID1, "requested", 600, None))
    listed(tool)
    assert capture(tool)["error"] == "inferred_card_open"


def test_none_within_three_days_of_a_decline_and_never_the_declined_text_again(tool, box, plugin):
    import sys as _sys

    ri = _sys.modules[f"{plugin.__name__}._record_intention"]
    box.run()
    box.approvals((ID1, "rejected", 2 * 24 * 3600, None))
    listed(tool)
    assert capture(tool)["error"] == "recently_declined"
    box.run(started_at=iso(80))  # the next night's run
    box.approvals((ID1, "rejected", 4 * 24 * 3600, ri.held_norm_hash(TEXT)))
    listed(tool)
    assert capture(tool)["error"] == "previously_declined"
    box.run(started_at=iso(75))
    listed(tool)
    assert capture(tool, "Looking for soil scientists to meet this month")["success"] is True


def test_without_a_woken_run_nothing_is_recorded(tool, box):
    box.run(woke=False, exit_branch="gated_no_change", finished_at=iso(84))
    assert capture(tool)["error"] == "no_gate_run"


def test_the_caps_hold_with_telemetry_off(plugin, box, monkeypatch):
    """The caps are the tool's own listeners, outside the collector's guard."""
    monkeypatch.setenv("AV_RECORD_INTENTION", "1")
    monkeypatch.delenv("AV_EVENTS_TOKEN", raising=False)
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    ctx = ToolCtx()
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=CRON_SESSION, model="m", platform="cron")
    box.run()
    listed(ctx)
    assert capture(ctx)["success"] is True
    assert capture(ctx, "Another want entirely, a running partner")["error"] == "pass_limit_reached"
    box.run()
    assert capture(ctx)["error"] == "intents_not_listed"


def test_another_cron_job_is_not_capped_here_and_its_origin_is_other(tool, box, av, plugin):
    out = capture(tool, session=OTHER_CRON)
    assert out["success"] is True
    assert events(av, plugin, "intention.captured")[0]["payload"]["origin"] == "other"


def test_a_chat_capture_has_origin_chat(tool, av, plugin, monkeypatch):
    import sys as _sys

    ri = _sys.modules[f"{plugin.__name__}._record_intention"]
    monkeypatch.setattr(ri, "publish_intent", lambda text, **_: ("01920000-0000-7000-8000-0000000000aa", None))
    out = capture(tool, session="dm")
    assert out["success"] is True
    assert events(av, plugin, "intention.captured")[0]["payload"]["origin"] == "chat"


def test_the_origin_of_a_subagent_of_the_pass_is_still_memory_signal_sync(tool, box, av, plugin):
    box.run()
    tool.fire("subagent_start", child_session_id="child-1", parent_session_id=CRON_SESSION)
    listed(tool, session="child-1")
    out = capture(tool, session="child-1")
    assert out["success"] is True
    assert events(av, plugin, "intention.captured")[0]["payload"]["origin"] == "memory_signal_sync"


# --------------------------------------------------------------------------
# End to end: the real gate, the tool, the tail
# --------------------------------------------------------------------------


def test_end_to_end_gate_list_record_and_the_recorded_event(tool, box, av, plugin, home, monkeypatch):
    monkeypatch.setenv("AV_INFERENCE_RUN_EVENTS", "1")
    (home / ".env").write_text("AV_RECORD_INTENTION=1\n")
    db = sqlite3.connect(home / "state.db")
    db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, chat_type TEXT, parent_session_id TEXT)")
    db.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)")
    db.execute("INSERT INTO sessions VALUES ('dm-1', 'telegram', 'dm', NULL)")
    for n in range(3):
        db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('dm-1','user',?,?)",
                   (f"I really need a hardware cofounder for the seed library, take {n}", time.time() - 600))
    db.commit()
    db.close()
    env = {k: v for k, v in os.environ.items() if k != "AV_RECORD_INTENTION"}
    env["HERMES_HOME"] = str(home)
    gate = subprocess.run([sys.executable, str(GATE), "--json-only"], env=env, capture_output=True, text=True, check=True)
    woke = json.loads(gate.stdout.strip().splitlines()[-1])
    assert woke["wakeAgent"] is True
    listed(tool)
    out = capture(tool)
    assert out["success"] is True
    state = json.loads((home / "memory" / "heartbeat-state.json").read_text())
    state["memorySignals"]["lastOutcome"] = {"runId": woke["runId"], "exit": "recorded", "candidatesConsidered": 1}
    (home / "memory" / "heartbeat-state.json").write_text(json.dumps(state))
    box.execution(ago=1, duration=30)
    box.audit(ago=2)
    plugin._COLLECTOR.cron_tick()
    found = events(av, plugin)
    assert len(found) == 1
    payload = found[0]["payload"]
    check_contract(payload)
    assert payload["run_id"] == woke["runId"]
    assert payload["exit_branch"] == "recorded" and payload["recorded_intent_id"] == out["intention_id"]
    assert payload["resident_messages_since_last_run"] == 3 and payload["existing_intents"] == 2
    assert payload["candidates_considered"] == 1


# --------------------------------------------------------------------------
# Fix round (refutation at 6834329): S1 capped, S3 last known, S4 the first refusal ends the pass
# --------------------------------------------------------------------------


@pytest.mark.parametrize("reason", ["capped_nightly", "capped_open_card", "capped_recent_decline"])
def test_s1_a_gate_cap_stop_is_reported_as_capped(live, box, av, reason):
    box.run(woke=False, exit_branch="capped", gate_reason=reason, finished_at=iso(84))
    box.execution()
    payload = tick_one(av, live)["payload"]
    assert payload["exit_branch"] == "capped" and payload["error_code"] is None
    assert payload["candidates_considered"] == 0 and payload["model"] == "none"


def test_s1_a_tool_cap_inside_a_woken_run_is_capped_not_the_models_word(tool, box, av, plugin, monkeypatch):
    monkeypatch.setenv("AV_INFERENCE_RUN_EVENTS", "1")
    record = box.run()
    listed(tool)
    box.approvals((ID1, "requested", 60, None))  # a card opened after the gate looked
    assert capture(tool)["error"] == "inferred_card_open"
    box.outcome(record["run_id"], "no_candidate", considered=1)
    box.execution()
    box.audit()
    plugin._COLLECTOR.cron_tick()
    payload = events(av, plugin)[0]["payload"]
    check_contract(payload)
    assert payload["exit_branch"] == "capped"


def test_s4_the_first_refusal_ends_the_pass_and_declined_text_is_matched_loosely(tool, box, av, plugin, monkeypatch):
    monkeypatch.setenv("AV_INFERENCE_RUN_EVENTS", "1")
    box.run(recorded_intent_id=ID1, recorded_text="Looking for a hardware co-founder for the seed library",
            village_date="2026-10-01", started_at=iso(10 * 24 * 3600), finished_at=iso(10 * 24 * 3600 - 60), woke=True)
    record = box.run()
    box.approvals((ID1, "rejected", 5 * 24 * 3600, None))
    listed(tool)
    # Case, spacing, punctuation, a hyphen or a unicode dash: the same declined text.
    assert capture(tool, "looking for a HARDWARE cofounder,  for the seed library!")["error"] == "previously_declined"
    assert capture(tool, "Looking for a hardware co\u2010founder for the seed library")["error"] == "previously_declined"
    # Anything else in this run is refused too: the first refusal ended it.
    assert capture(tool, "Looking for soil scientists to meet this month")["error"] == "previously_declined"
    assert box.runs()[-1]["recorded_intent_id"] is None and box.runs()[-1]["refusal"] == "previously_declined"
    box.execution()
    plugin._COLLECTOR.cron_tick()
    payload = events(av, plugin)[0]["payload"]
    assert payload["run_id"] == record["run_id"] and payload["exit_branch"] == "candidate_previously_declined"


def test_s4_a_corrupt_map_ends_the_pass_with_no_record(tool, box, home):
    box.run()
    listed(tool)
    (home / "av-events" / "intentions.json").write_text("{not json")
    assert capture(tool)["error"] == "caps_unknown"
    # The corrupt map was set aside, so a retry would see no open card: it is refused all the same.
    assert capture(tool)["error"] == "caps_unknown"
    assert box.runs()[-1]["recorded_intent_id"] is None


def test_s4_a_validation_refusal_ends_the_pass_too(tool, box):
    box.run()
    listed(tool)
    out = tool.tools["record_intention"]["handler"]({"text": TEXT, "source": "ambient", "publish": "maybe"},
                                                    session_id=CRON_SESSION, task_id="t")
    assert json.loads(out)["error"] == "publish_invalid"
    assert capture(tool)["error"] == "publish_invalid"


def test_arm_on_boxes_index_read_intents_counts_as_listed(tool, box):
    box.run()
    listed(tool, name="index_read_intents", args={})
    assert box.runs()[-1]["intents_listed"] is True
    assert capture(tool)["success"] is True


def test_an_index_read_intents_behind_some_mcp_server_is_not_the_plugin(tool, box):
    box.run()
    listed(tool, name="mcp__other__index_read_intents", args={})
    assert capture(tool)["error"] == "intents_not_listed"


def test_s3_no_gate_record_sends_the_last_known_counters(live, box, av, home):
    box.run(woke=False, exit_branch="gated_no_change", finished_at=iso(5000), started_at=iso(5100),
            stated_goals=2, memory_bytes=300, prior_declines=1, resident_messages_since_last_run=1,
            existing_intents=4, intents_listed=True)
    box.execution()  # a run whose gate left nothing
    payload = tick_one(av, live)["payload"]
    assert (payload["exit_branch"], payload["error_code"]) == ("error", "unknown")
    assert (payload["stated_goals"], payload["memory_bytes"], payload["prior_declines"], payload["existing_intents"]) == (2, 300, 1, 4)


def test_s3_an_exception_sends_the_last_known_counters_and_still_no_text(live, box, av, monkeypatch):
    import sys as _sys

    ir = _sys.modules[f"{live.__name__}._inference_run"]
    box.run(stated_goals=3, memory_bytes=120, existing_intents=2, intents_listed=True)

    def boom(home, execution):
        raise RuntimeError("SECRET")

    monkeypatch.setattr(ir, "finalize", boom)
    box.execution()
    payload = tick_one(av, live)["payload"]
    assert (payload["exit_branch"], payload["error_code"]) == ("error", "unknown")
    assert payload["stated_goals"] == 3 and payload["existing_intents"] == 2


def test_s3_a_gated_run_sends_the_last_listed_intents(live, box, av):
    box.run(woke=False, exit_branch="gated_no_change", finished_at=iso(84), existing_intents=5)
    box.execution()
    assert tick_one(av, live)["payload"]["existing_intents"] == 5
