"""DATA-109: turns Hermes injects into a participant's session are `actor: system`.

The Hermes gateway runs its own synthetic turns through the normal agent turn
in the participant's session, and `pre_llm_call` hands the synthetic text over
as `user_message` with no flag. Hermes does stamp the turn's user dict with
`display_kind = "internal_notification"` for every `MessageEvent(internal=True)`
and the heartbeat (`gateway/response_filters.py` `display_kind_for_event`,
`agent/turn_context.py` `_stage_turn_user_message`), and that dict is the last
item of the hook's `conversation_history`. The `/goal` continuation is not
internal and is known only by its header. Texts below are Hermes's own shapes
(`hermes-agent` main at `118984d7a0`).
"""

from __future__ import annotations

import pytest

SESSION = "sess-inj"
CRON = "cron_ab12cd34ef56_20260927_090000"
INTERNAL = "internal_notification"

EARLIER = [
    {"role": "user", "content": "What is on tonight?"},
    {"role": "assistant", "content": "The hardware dinner at 7."},
]

#: (kind, text, display_kind) for every injected-turn kind DATA-109 lists.
INJECTED = [
    # gateway/run_notifications.py: a background process's watch pattern matched.
    ("process_watch", '[IMPORTANT: Background process proc_1 matched watch pattern "ERROR".\nLast lines: ...]', INTERNAL),
    # gateway/run_notifications.py: a background process finished.
    ("process_complete", "[IMPORTANT: Background process proc_1 completed (exit code 0).\nOutput tail: ...]", INTERNAL),
    # gateway/wake.py: an async delegation's result delivered back into the session.
    ("delegation_complete", "Delegated task finished: the research summary is ready.", INTERNAL),
    # gateway/run_goals.py: a /loop wakeup.
    ("loop_wakeup", "[/loop wakeup #3, every 10m]\nRecurring task: check the RSVP list\n\nThis is an automatic wakeup", INTERNAL),
    # hermes_cli/loops.py: a loop whose prompt is a slash command is injected as the bare command.
    ("loop_slash_command", "/status", INTERNAL),
    # gateway/run_goals.py: the /goal continuation is NOT internal; its header is all there is.
    ("goal_continuation", "[Continuing toward your standing goal]\nGoal: book the dinner\n\nKeep going.", None),
    ("goal_gate_failed", "[Continuing toward your standing goal — a quality gate failed]\nGoal: ...", None),
    # gateway/run_goals.py: the heartbeat prompt stays non-internal but is typed internal_notification.
    ("heartbeat", "Check in on today's agenda.", INTERNAL),
    # gateway/run_startup.py + gateway/run.py: the restart auto-resume turn (empty text, note persisted).
    ("restart_resume",
     "[System note: The previous turn was interrupted by a gateway restart; the gateway is now back online. "
     "Report to the user that the session was restored successfully and ask what they would like to do next.]",
     INTERNAL),
    # gateway/run_inbound.py: a plugin injected a prompt into the session.
    ("plugin_injection", "The Index plugin found two new matches for your intent.", INTERNAL),
    # gateway/run_startup.py: the CLI-to-channel handoff.
    ("cli_handoff",
     '[Session was just handed off from CLI ("plan") to this channel. The full prior conversation history '
     "is loaded above. Briefly confirm you're working here and summarize what we were working on.]",
     INTERNAL),
]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    return plugin


def turn(ctx, text, display_kind=None, *, session=SESSION, platform="telegram", history=None, start=True):
    """One turn as Hermes fires it: the turn's user dict is the last history item."""
    if start:
        ctx.fire("on_session_start", session_id=session, model="m", platform=platform)
    current = {"role": "user", "content": text}
    if display_kind is not None:
        current["display_kind"] = display_kind
    conversation = list(EARLIER if history is None else history) + [current]
    ctx.fire("pre_llm_call", session_id=session, task_id=session, turn_id="t1", user_message=text,
             conversation_history=conversation, is_first_turn=False, model="m", platform=platform,
             parent_session_id="", sender_id="123456789")
    ctx.fire("post_llm_call", session_id=session, task_id=session, turn_id="t1", user_message=text,
             assistant_response="Noted.", conversation_history=conversation, model="m", platform=platform)


def events(av, plugin, kind):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == kind]


@pytest.mark.parametrize("kind,text,display_kind", INJECTED, ids=[k for k, _, _ in INJECTED])
def test_each_injected_turn_kind_is_a_system_message(live, ctx, av, kind, text, display_kind):
    turn(ctx, text, display_kind)
    inbound = events(av, live, "message.in")
    assert len(inbound) == 1
    assert inbound[0]["actor"] == "system", kind
    # The session's own channel: the turn happened in the participant's chat.
    assert inbound[0]["payload"]["channel"] == "telegram"
    assert inbound[0]["payload"]["cron_job_id"] is None
    # The reply is still the agent's.
    assert [e["actor"] for e in events(av, live, "message.out")] == ["agent"]


@pytest.mark.parametrize("text", [
    "[/loop wakeup #1, self-paced]\nRecurring task: tidy notes",
    "[IMPORTANT: Background process proc_9 failed (exit code 1).]",
    '[Session was just handed off from CLI ("x") to this channel.]',
    "[System note: The previous turn was interrupted by a gateway shutdown; the gateway is now back online.]",
])
def test_a_known_header_marks_the_turn_without_a_display_kind(live, ctx, av, text):
    """A Hermes whose user dict carries no `display_kind` still has the headers."""
    turn(ctx, text, None)
    assert [e["actor"] for e in events(av, live, "message.in")] == ["system"]


def test_the_participants_own_message_stays_participant(live, ctx, av):
    turn(ctx, "Can you RSVP me to the hardware dinner?", None)
    assert [e["actor"] for e in events(av, live, "message.in")] == ["participant"]


def test_an_earlier_injected_row_does_not_mark_the_next_human_turn(live, ctx, av):
    history = EARLIER + [
        {"role": "user", "content": "[IMPORTANT: Background process proc_1 completed (exit code 0).]",
         "display_kind": INTERNAL},
        {"role": "assistant", "content": "Your export finished."},
    ]
    turn(ctx, "Thanks, send it to me.", None, history=history)
    assert [e["actor"] for e in events(av, live, "message.in")] == ["participant"]


def test_a_history_without_the_current_turn_is_not_read_as_it(live, ctx, av):
    """If a Hermes passed history without this turn's dict, the last item is
    the previous reply, not an injected row: the turn stays the participant's."""
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    history = [{"role": "user", "content": "[/loop wakeup #1]", "display_kind": INTERNAL},
               {"role": "assistant", "content": "Done.", "display_kind": INTERNAL}]
    ctx.fire("pre_llm_call", session_id=SESSION, task_id=SESSION, turn_id="t1",
             user_message="And tomorrow?", conversation_history=history, model="m", platform="telegram")
    assert [e["actor"] for e in events(av, live, "message.in")] == ["participant"]


def test_a_real_message_sent_during_a_pending_resume_stays_participant(live, ctx, av):
    """Hermes wraps it in the recovery note for the model but hands the hook the
    user's clean words, and the turn is not internal."""
    turn(ctx, "Did the RSVP go through?", None)
    assert [e["actor"] for e in events(av, live, "message.in")] == ["participant"]


def test_a_header_quoted_mid_message_is_the_participants(live, ctx, av):
    turn(ctx, "Why did you say [/loop wakeup #3] earlier?", None)
    assert [e["actor"] for e in events(av, live, "message.in")] == ["participant"]


def test_an_unknown_display_kind_is_not_injected(live, ctx, av):
    turn(ctx, "Change of plan: skip the dinner.", "steer")
    assert [e["actor"] for e in events(av, live, "message.in")] == ["participant"]


@pytest.mark.parametrize("display_kind", [INTERNAL, None])
def test_a_cron_run_stays_a_cron_system_message(live, ctx, av, display_kind):
    """Cron is its own session kind (`platform="cron"`, a `cron_<job>_<stamp>` id,
    `HERMES_CRON_SESSION=1` bound by the scheduler for the same runs): the
    prompt was always `system` on channel `cron`, with its job id, and an
    injected-turn mark changes none of that."""
    turn(ctx, "[Continuing toward your standing goal]\nGoal: digest", display_kind, session=CRON, platform="cron")
    inbound = events(av, live, "message.in")
    assert [e["actor"] for e in inbound] == ["system"]
    assert inbound[0]["payload"]["channel"] == "cron"
    assert inbound[0]["payload"]["cron_job_id"] == "ab12cd34ef56"


def test_a_subagents_goal_stays_the_delegating_agents(live, ctx, av):
    ctx.fire("on_session_start", session_id="parent", model="m", platform="telegram")
    ctx.fire("subagent_start", parent_session_id="parent", child_session_id="child", child_role="r", child_goal="g")
    turn(ctx, "Research the venues.", INTERNAL, session="child", platform="", start=False)
    inbound = events(av, live, "message.in")
    assert [(e["actor"], e["payload"]["channel"]) for e in inbound] == [("agent", "subagent")]


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_the_mark_rides_every_capture_mode(plugin, ctx, monkeypatch, av, mode):
    """`actor` is an envelope fact, not content: `metadata` keeps it too."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    turn(ctx, "[/loop wakeup #2, every 1h]\nRecurring task: check", INTERNAL)
    assert [e["actor"] for e in events(av, plugin, "message.in")] == ["system"]
