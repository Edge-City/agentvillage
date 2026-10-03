"""Publishing intentions through the resident's approval.md (DATA-212 Lane B).

Rulings R16..R24 (`data-212-approval-half-design-20261001.md`) and the Lane B
contract (`data-212-lane-b-contract-20261002.md`), against the `propose`,
`wait --timeout 0` and `start` verbs of approval.md PR #569. On only when
`AV_APPROVAL_ENABLED` is on and `AV_APPROVAL_URL` is set (`_approval`); off,
`record_intention` behaves exactly as before (ambient held, confirm refused).

**What is proposed.** Every capture that would publish becomes a proposal
before anything reaches Index:

- an ambient (inferred) capture: class `intent.publish.inferred.index`;
- an explicit capture with `publish` true in a session that may publish:
  class `intent.publish.stated.index`.

Key `<class>:<intention_id>` (the key must start with the class; core refuses
`key-class-mismatch` otherwise), where `intention_id` is a uuid v7 minted at
capture. That id is the one the tool returns, the one the data side parses
back out of the key (R21), and the `sourceId` Index stores on the intent
(DATA-249 O4, decision A amending R20). Summary `SUMMARIES[class]` plus the
id: it names no part of the text, because the summary is stored in the log in
cleartext twice. Payload `{"text": <the text>}` as compact JSON (UTF-8, at
most 262144 bytes): the bytes the resident is shown and grants.

**Where the text is held (R16).** The payload string is kept in the plugin's
own map (`$HERMES_HOME/av-events/intentions.json`, 0600, under the map's
flock) as `approval.payload` on the intention's entry, from capture until the
proposal ends: it is deleted when the intention is published, when Index
refuses it (422) or the publish is ambiguous, when the resident rejects it,
when the agent withdraws it, and when it expires for the last time. A
proposal core refuses (`class-not-agent-requestable` and kin) keeps it, so a
`confirm` after the policy changes can file it again. It never appears in a
log line, an event, or the summary; the published text is
`json.loads(payload)["text"]`, the very string `start` was given, so the
Index intent and the granted bytes cannot differ.

**The state machine** (`approval.state` in the entry; every transition is a
compare-and-set under the map's flock, so two processes, or the poller and a
tool call, never both take the same step):

    unfiled --propose--> requested | granted | cleared (policy said
                         autonomous or supervised) | started (core says the
                         key already executed) | refused (core refused it)
    requested --wait 0--> granted | started (nothing-to-wait-for: our start
                         spent the grant) | rejected | withdrawn |
                         unfiled (expired: re-proposed with the same bytes at
                         most twice; void after a policy re-attest; a task
                         the log no longer knows)
    granted | cleared --precheck, rate cap, start--> started |
                         unfiled (not-granted, expired, policy-drift: the
                         re-proposal tells an earlier start from a new
                         question) | refused
    started --mark publishing, POST /api/intents--> published |
                         index_rejected (422) | ambiguous (Index may have
                         written) | started (nothing was written: retried)
    publishing, older than twice Index's deadline --> ambiguous

**No duplicate publish across restarts.** `publishing` is written to the map
before the Index request and only from `started`; a process that finds
`publishing` it did not just write cannot know whether Index took it, so after
`STALE_PUBLISHING_S` it records `ambiguous` (`publish_refused: timeout`, the
code the data side reconciles by `sourceId` and text hash) and never sends it
again. A crash between `start` and the map write is recovered without a second
`start`: the re-proposal answers `state: executed` (or `wait` answers
`nothing-to-wait-for`), the map moves to `started`, and because `publishing`
was never written, Index was never called.

**A stale grant after a policy re-attest.** `wait` answers `void` (exit 7)
and `start` refuses `policy-drift`; both re-propose the same bytes, which
core files as a new question under the new policy.

**Events.** A publish (or a definite refusal) that happens inside the capture
call is reported in the tool's result, and the observer emits the one
`intention.captured`. One that happens later (the poller, or `confirm`) is
emitted here as `intention.updated` with `index_intent_id`, `approved_by`
(`individual` for a human's grant, `rule` for the policy) and
`approval_state`, through the emitter the plugin registers (`set_emitter`).

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any, Callable, Optional

from . import _approval
from ._core import env

logger = logging.getLogger("av-events")

INFERRED_CLASS = "intent.publish.inferred.index"
STATED_CLASS = "intent.publish.stated.index"
CLASSES = (INFERRED_CLASS, STATED_CLASS)

#: The summary the resident's prompt and the log carry: never any of the text.
SUMMARIES = {
    INFERRED_CLASS: "Publish to Index an intention your agent inferred",
    STATED_CLASS: "Publish to Index an intention you stated",
}

APPROVAL_KEY = "approval"
#: States in which the poller still has work to do.
LIVE = frozenset({"unfiled", "requested", "granted", "cleared", "started", "publishing"})
#: Terminal states that end the proposal and drop the held text.
TERMINAL_DROP = frozenset({"published", "rejected", "withdrawn", "index_rejected", "ambiguous", "expired"})

MAX_PAYLOAD_BYTES = 262144
MAX_EXPIRED_REPROPOSALS = 2
#: Each one needs a human to re-attest the policy; the cap only stops a loop.
MAX_VOID_REPROPOSALS = 10
MAX_STEPS = 10
MAX_PER_PASS = 50
#: A tool call that is advancing an entry itself keeps the poller off it.
INLINE_GRACE_S = 90.0

#: Codes core answers that end a proposal until something changes (a policy
#: edit, a new capture): the held text is kept so `confirm` can file it again.
REFUSED_CODES = frozenset({
    "class-not-agent-requestable", "class-human-only", "key-class-mismatch", "payload-too-large",
    "payload-mismatch", "duplicate-request", "task-not-proposal", "not-requester", "task-is-proposal",
    "usage",
})

_emitter: Optional[Callable[..., None]] = None


def set_emitter(fn: Optional[Callable[..., None]]) -> None:
    """The plugin's `intention.updated` emitter for publishes outside a tool call."""
    global _emitter
    _emitter = fn


def active() -> bool:
    return _approval.configured()


def _ri():
    from . import _record_intention

    return _record_intention


def key_for(cls: str, intention_id: str) -> str:
    return f"{cls}:{intention_id}"


def summary_for(cls: str, intention_id: str) -> str:
    return f"{SUMMARIES[cls]} (intention {intention_id})."


def payload_for(text: str) -> Optional[str]:
    """`{"text": ...}` as compact JSON, or None when it is over core's limit."""
    payload = json.dumps({"text": text}, ensure_ascii=False, separators=(",", ":"))
    return payload if len(payload.encode("utf-8")) <= MAX_PAYLOAD_BYTES else None


def text_of(payload: Any) -> Optional[str]:
    try:
        value = json.loads(payload)
    except (TypeError, ValueError):
        return None
    text = value.get("text") if isinstance(value, dict) else None
    return text if isinstance(text, str) and text else None


class Outcome:
    """Where an advance left the proposal."""

    __slots__ = ("state", "code", "index_intent_id", "authorization", "task")

    def __init__(self, state: str, *, code: Optional[str] = None, index_intent_id: Optional[str] = None,
                 authorization: Optional[str] = None, task: Optional[str] = None) -> None:
        self.state = state
        self.code = code
        self.index_intent_id = index_intent_id
        self.authorization = authorization
        self.task = task

    @property
    def approved_by(self) -> Optional[str]:
        return {"grant": "individual", "policy": "rule"}.get(self.authorization or "")


def approval_of(entry: Optional[dict]) -> Optional[dict]:
    ap = entry.get(APPROVAL_KEY) if isinstance(entry, dict) else None
    return ap if isinstance(ap, dict) else None


def is_live(entry: Optional[dict]) -> bool:
    ap = approval_of(entry)
    return ap is not None and ap.get("state") in LIVE


# ---- Map transitions ------------------------------------------------------


def _cas(intention_id: str, expect: Optional[frozenset[str] | set[str] | tuple[str, ...]],
         change: Callable[[dict, dict], None]) -> Optional[dict]:
    """Under the map lock: when the entry's approval state is in `expect` (any
    state when None), apply `change(entry, approval)` and save. The entry after
    the change, else None."""
    ri = _ri()
    try:
        with ri._Locked():
            entries, publishes = ri._load_locked()
            entry = entries.get(intention_id)
            ap = approval_of(entry)
            if ap is None or (expect is not None and ap.get("state") not in expect):
                return None
            change(entry, ap)
            ap["updated_at"] = float(ri._clock())
            if ap.get("state") in TERMINAL_DROP:
                ap.pop("payload", None)
                ap.pop("inline_until", None)
            ri._save_locked(entries, publishes)
            return json.loads(json.dumps(entry))
    except Exception as exc:  # noqa: BLE001 - a map that cannot be written moves nothing
        logger.warning("av-events: approval map_write_failed=%s", type(exc).__name__)
        return None


def _set_state(intention_id: str, expect, state: str, **fields: Any) -> Optional[dict]:
    def change(_entry: dict, ap: dict) -> None:
        ap["state"] = state
        for name, value in fields.items():
            if value is None:
                ap.pop(name, None)
            else:
                ap[name] = value

    return _cas(intention_id, frozenset(expect), change)


def _note_code(intention_id: str, code: str) -> None:
    def change(_entry: dict, ap: dict) -> None:
        ap["code"] = code

    _cas(intention_id, LIVE, change)


def open_entry(intention_id: str, *, cls: str, text: str, source: str, norm_hash: Optional[str],
               inline: bool = True) -> Optional[str]:
    """Write a new entry holding the proposal (state `unfiled`). None, or a code
    when nothing could be held (`payload_too_large`, `map_unwritable`)."""
    payload = payload_for(text)
    if payload is None:
        return "payload_too_large"
    ri = _ri()
    try:
        with ri._Locked():
            entries, publishes = ri._load_locked()
            now = float(ri._clock())
            entry: dict[str, Any] = {"published": False, "source": source}
            if norm_hash is not None and source == ri.RESTRICTIVE_SOURCE:
                entry[ri.HELD_HASH_KEY] = norm_hash
            approval: dict[str, Any] = {
                "class": cls,
                "key": key_for(cls, intention_id),
                "payload": payload,
                "state": "unfiled",
                "opened_at": now,
                "updated_at": now,
            }
            if inline:
                approval["inline_until"] = now + INLINE_GRACE_S
            entry[APPROVAL_KEY] = approval
            entries.pop(intention_id, None)
            entries[intention_id] = entry
            ri._evict(entries)
            ri._save_locked(entries, publishes)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: approval map_write_failed=%s", type(exc).__name__)
        return "map_unwritable"


def end_inline(intention_id: str) -> None:
    def change(_entry: dict, ap: dict) -> None:
        ap.pop("inline_until", None)

    _cas(intention_id, None, change)


# ---- Advancing one proposal -----------------------------------------------


def _propose(intention_id: str, ap: dict) -> Optional[Outcome]:
    """unfiled -> the state core's answer names. None to continue the loop."""
    try:
        answer = _approval.propose(ap["class"], ap["key"], summary_for(ap["class"], intention_id), ap["payload"])
    except _approval.ApprovalUnavailable as exc:
        _note_code(intention_id, exc.code)
        return Outcome("unfiled", code=exc.code)
    if not answer.ok:
        code = answer.error_code or f"exit_{answer.exit_code}"
        if code in REFUSED_CODES:
            _set_state(intention_id, {"unfiled"}, "refused", code=code)
            logger.info("av-events: approval proposal_refused=%s", code)
            return Outcome("refused", code=code)
        _note_code(intention_id, code)
        return Outcome("unfiled", code=code)
    doc = answer.doc
    task = doc.get("task") if isinstance(doc.get("task"), str) else None
    decision = doc.get("decision")
    state = doc.get("state")
    if task is None or not task.startswith("propose:"):
        _note_code(intention_id, "bad_answer")
        return Outcome("unfiled", code="bad_answer")
    if state == "executed":
        new = "started"
    elif decision == "requested":
        new = {"requested": "requested", "granted": "granted"}.get(state, "")
        if not new:
            # rejected or revoked: the resident has answered this key before.
            new = "rejected"
    elif decision in ("autonomous", "supervised"):
        new = "cleared"
    else:
        _note_code(intention_id, "bad_answer")
        return Outcome("unfiled", code="bad_answer")
    _set_state(intention_id, {"unfiled"}, new, task=task, code=None)
    if new in ("requested", "rejected"):
        # The resident has just been asked (or had answered before): nothing
        # more to learn in this call.
        return Outcome(new, task=task)
    return None


def _repropose(intention_id: str, kind: str, cap: int, expect: set[str]) -> Optional[Outcome]:
    """Back to `unfiled` so the same bytes are proposed again, or `expired` past the cap."""
    counter = f"reproposals_{kind}"

    def change(_entry: dict, ap: dict) -> None:
        count = int(ap.get(counter) or 0)
        if count >= cap:
            ap["state"] = "expired"
            ap["code"] = kind
            return
        ap[counter] = count + 1
        ap["state"] = "unfiled"
        ap["code"] = kind

    after = _cas(intention_id, frozenset(expect), change)
    ap = approval_of(after)
    if ap is not None and ap.get("state") == "expired":
        return Outcome("expired", code=kind)
    return None


def _wait(intention_id: str, ap: dict) -> Optional[Outcome]:
    task = ap.get("task")
    if not isinstance(task, str):
        _set_state(intention_id, {"requested"}, "unfiled")
        return None
    try:
        answer = _approval.wait(task)
    except _approval.ApprovalUnavailable as exc:
        _note_code(intention_id, exc.code)
        return Outcome("requested", code=exc.code, task=task)
    code, status = answer.exit_code, answer.status
    if code == 6:
        return Outcome("requested", task=task)
    if code == 0 and status == "granted":
        _set_state(intention_id, {"requested"}, "granted", code=None)
        return None
    if code == 0 and status in ("executed", "nothing-to-wait-for"):
        # Every grant of this key is spent, and only this actor can spend it
        # (`start` is requester-only): an earlier start of ours whose map write
        # was lost. The re-proposal confirms it (`state: executed`).
        _set_state(intention_id, {"requested"}, "unfiled", code=status)
        return None
    if code == 1:
        if answer.error_code == "not-registered":
            _set_state(intention_id, {"requested"}, "unfiled", code="not-registered")
            return None
        terminal = "withdrawn" if status == "withdrawn" else "rejected"
        _set_state(intention_id, {"requested"}, terminal, code=status or "rejected")
        return Outcome(terminal, task=task)
    if code == 3:
        return _repropose(intention_id, "expired", MAX_EXPIRED_REPROPOSALS, {"requested"})
    if code == 7:
        return _repropose(intention_id, "void", MAX_VOID_REPROPOSALS, {"requested"})
    _note_code(intention_id, f"wait_exit_{code}")
    return Outcome("requested", code=f"wait_exit_{code}", task=task)


def _start(intention_id: str, ap: dict, state: str, ctx: dict) -> Optional[Outcome]:
    """granted | cleared -> started. The publish precheck and the rate cap come
    first (R18), so an execution is recorded only when the publish can follow;
    the attempt reserved here is the one `_publish` then makes."""
    ri = _ri()
    code = ri._publish_precheck()
    if code is None:
        code = ri.reserve_publish()
    if code is not None:
        _note_code(intention_id, code)
        return Outcome(state, code=code)
    ctx["reserved"] = True
    try:
        answer = _approval.start(ap["task"], ap["key"], ap["payload"])
    except _approval.ApprovalUnavailable as exc:
        _note_code(intention_id, exc.code)
        return Outcome(state, code=exc.code)
    if answer.ok:
        authorization = answer.doc.get("authorization")
        authorization = authorization if authorization in ("grant", "policy") else None
        _set_state(intention_id, {state}, "started", authorization=authorization, code=None)
        return None
    error = answer.error_code or f"exit_{answer.exit_code}"
    if error == "already-executed":
        _set_state(intention_id, {state}, "started", code=None)
        return None
    if error in ("not-granted", "expired", "policy-drift", "not-registered"):
        kind = "void" if error == "policy-drift" else "expired"
        cap = MAX_VOID_REPROPOSALS if kind == "void" else MAX_EXPIRED_REPROPOSALS
        if error == "not-granted":
            # Our own spent grant reads not-granted on a second start; the
            # re-proposal answers `executed` then, and files nothing new.
            _set_state(intention_id, {state}, "unfiled", code=error)
            return None
        return _repropose(intention_id, kind, cap, {state})
    if error in REFUSED_CODES:
        _set_state(intention_id, {state}, "refused", code=error)
        return Outcome("refused", code=error)
    _note_code(intention_id, error)
    return Outcome(state, code=error)


def _publish(intention_id: str, ap: dict, reserved: bool) -> Outcome:
    ri = _ri()
    if not reserved:
        # A retry, or a resumed start: each attempt counts against the cap.
        code = ri._publish_precheck()
        if code is None:
            code = ri.reserve_publish()
        if code is not None:
            _note_code(intention_id, code)
            return Outcome("started", code=code)
    text = text_of(ap.get("payload"))
    if text is None:
        # The held bytes are gone or not ours: nothing to publish that matches the grant.
        _set_state(intention_id, {"started"}, "refused", code="payload_missing")
        return Outcome("refused", code="payload_missing")
    now = float(ri._clock())
    if _set_state(intention_id, {"started"}, "publishing", publishing_at=now) is None:
        return Outcome("publishing")
    index_id, code = ri.publish_intent(text, source_id=intention_id)
    authorization = ap.get("authorization") if ap.get("authorization") in ("grant", "policy") else None
    if index_id is not None:
        def change(entry: dict, apx: dict) -> None:
            apx["state"] = "published"
            apx.pop("code", None)
            apx.pop("publishing_at", None)
            entry["published"] = True
            entry["index_intent_id"] = index_id
            entry.pop(ri.HELD_HASH_KEY, None)

        _cas(intention_id, {"publishing"}, change)
        return Outcome("published", index_intent_id=index_id, authorization=authorization)
    if code == "rejected":
        def change_rejected(entry: dict, apx: dict) -> None:
            apx["state"] = "index_rejected"
            apx["code"] = "rejected"
            apx.pop("publishing_at", None)
            entry["refused"] = "rejected"
            entry.pop(ri.HELD_HASH_KEY, None)

        _cas(intention_id, {"publishing"}, change_rejected)
        return Outcome("index_rejected", code="rejected", authorization=authorization)
    if code == ri.AMBIGUOUS:
        _set_state(intention_id, {"publishing"}, "ambiguous", code=code, publishing_at=None)
        return Outcome("ambiguous", code=code, authorization=authorization)
    # Nothing reached Index (a refused connection, a 4xx other than 422, a 503):
    # back to `started`, and the next pass tries again under the rate cap.
    _set_state(intention_id, {"publishing"}, "started", code=code, publishing_at=None)
    return Outcome("started", code=code, authorization=authorization)


def advance(intention_id: str, *, emit: bool, inline: bool = False) -> Outcome:
    """Take the proposal as far as it can go now. Never raises.

    `emit`: report a publish (or a definite Index refusal) as
    `intention.updated` here, because no tool result will carry it. `inline`:
    the capture call itself is advancing; the poller is kept off meanwhile.
    """
    ri = _ri()
    outcome = Outcome("unknown")
    ctx: dict[str, Any] = {"reserved": False}
    try:
        for _ in range(MAX_STEPS):
            entry = ri.lookup(intention_id)
            ap = approval_of(entry)
            if ap is None:
                return Outcome("none")
            state = ap.get("state")
            if not inline and isinstance(ap.get("inline_until"), (int, float)) and ap["inline_until"] > float(ri._clock()):
                return Outcome(state or "unknown")
            if state not in LIVE:
                return Outcome(state or "unknown", code=ap.get("code"), task=ap.get("task"),
                               index_intent_id=entry.get("index_intent_id") if isinstance(entry, dict) else None,
                               authorization=ap.get("authorization"))
            if state == "unfiled":
                result = _propose(intention_id, ap)
            elif state == "requested":
                result = _wait(intention_id, ap)
            elif state in ("granted", "cleared"):
                result = _start(intention_id, ap, state, ctx)
            elif state == "started":
                result = _publish(intention_id, ap, ctx["reserved"])
                if result.state in ("published", "index_rejected", "ambiguous") and emit:
                    _emit(intention_id, entry, ap, result)
                return result
            else:  # publishing
                published_at = ap.get("publishing_at")
                stale = not isinstance(published_at, (int, float)) or (
                    float(ri._clock()) - float(published_at) > STALE_PUBLISHING_S())
                if not stale:
                    return Outcome("publishing")
                # B1 discipline: Index may have written. Never sent again.
                if _set_state(intention_id, {"publishing"}, "ambiguous", code=ri.AMBIGUOUS, publishing_at=None):
                    result = Outcome("ambiguous", code=ri.AMBIGUOUS, authorization=ap.get("authorization"))
                    if emit:
                        _emit(intention_id, entry, ap, result)
                    return result
                continue
            if result is not None:
                return result
        return outcome
    except Exception as exc:  # noqa: BLE001 - never into Hermes, never kills the poller
        logger.warning("av-events: approval advance_failed=%s", type(exc).__name__)
        return Outcome("error", code="internal")


def STALE_PUBLISHING_S() -> float:  # noqa: N802 - read at call time so tests can shorten Index's deadline
    return _ri().INDEX_DEADLINE_S * 2


def _emit(intention_id: str, entry: Optional[dict], ap: dict, outcome: Outcome) -> None:
    if _emitter is None:
        return
    text = text_of(ap.get("payload"))
    source = entry.get("source") if isinstance(entry, dict) else None
    try:
        _emitter(
            intention_id=intention_id,
            text=text,
            source=source,
            index_intent_id=outcome.index_intent_id,
            publish_refused=None if outcome.state == "published" else outcome.code,
            approved_by=outcome.approved_by,
            approval_state=outcome.state,
        )
    except Exception as exc:  # noqa: BLE001 - telemetry never costs the publish
        logger.warning("av-events: approval emit_failed=%s", type(exc).__name__)


# ---- The agent's withdraw -------------------------------------------------


def withdraw_local(intention_id: str) -> Optional[str]:
    """End a live proposal because the agent withdrew the intention. None when
    done (or there was none), `approval_publishing` while Index is being
    written. A pending question is withdrawn on the daemon, best effort."""
    entry = _ri().lookup(intention_id)
    ap = approval_of(entry)
    if ap is None or ap.get("state") not in LIVE:
        return None
    if ap.get("state") == "publishing":
        return "approval_publishing"
    previous = ap.get("state")
    task = ap.get("task")
    after = _set_state(intention_id, LIVE - {"publishing"}, "withdrawn", code="agent_withdrew")
    if after is None:
        return "approval_publishing"
    if previous == "requested" and isinstance(task, str):
        try:
            _approval.withdraw(task, "the agent withdrew the intention")
        except _approval.ApprovalUnavailable as exc:
            logger.info("av-events: approval withdraw_unsent=%s", exc.code)
        except Exception as exc:  # noqa: BLE001
            logger.info("av-events: approval withdraw_unsent=%s", type(exc).__name__)
    return None


def reopen(intention_id: str) -> bool:
    """`confirm` on a proposal core refused (`class-not-agent-requestable` and
    kin), whose held text was kept: file it again, in case the policy changed.
    True when it was reopened."""
    def change(_entry: dict, ap: dict) -> None:
        ap["state"] = "unfiled"
        ap.pop("code", None)

    return _cas(intention_id, {"refused"}, change) is not None


# ---- The pass and the poller ----------------------------------------------


def run_intent_pass() -> None:
    """Advance every live proposal once (at most `MAX_PER_PASS`)."""
    if not active():
        return
    ri = _ri()
    try:
        entries = ri._load_map()
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: approval map_read_failed=%s", type(exc).__name__)
        return
    now = float(ri._clock())
    todo = []
    for intention_id, entry in entries.items():
        ap = approval_of(entry)
        if ap is None or ap.get("state") not in LIVE:
            continue
        until = ap.get("inline_until")
        if isinstance(until, (int, float)) and until > now:
            continue
        todo.append(intention_id)
    counts: dict[str, int] = {}
    for intention_id in todo[:MAX_PER_PASS]:
        outcome = advance(intention_id, emit=True)
        counts[outcome.state] = counts.get(outcome.state, 0) + 1
    if counts:
        logger.info("av-events: approval pass %s", " ".join(f"{k}={v}" for k, v in sorted(counts.items())))


#: Hermes gateway platforms (`gateway/config.py` `Platform`), plus `cron`: the
#: scheduler runs inside the gateway. A session on one of these means this
#: process is the gateway. `cli`, `tui`, `desktop`, `acp` and `subagent` do not.
LOCAL_PLATFORMS = frozenset({"cli", "tui", "desktop", "acp", "subagent", "local", ""})


def _gateway_argv(argv: Optional[list] = None) -> bool:
    """`hermes gateway run` (and `start`): the gateway's own command line."""
    args = [str(a) for a in (sys.argv if argv is None else argv)][1:5]
    if "gateway" not in args:
        return False
    rest = args[args.index("gateway") + 1:]
    return not rest or rest[0] in ("run", "start")


def maybe_start(platform: Any = None, argv: Optional[list] = None) -> str:
    """Start the poller thread when this looks like the gateway process, else
    run one pass off-thread (the `on_session_start` resume). Which it did:
    `thread`, `pass`, or `off` (approval not configured)."""
    if not active():
        return "off"
    _approval.register_pass("intents", run_intent_pass)
    mode = env(_approval.POLLER_ENV).strip().lower()
    name = str(platform or "").strip().lower()
    gateway = mode in _approval.TRUTHY or _gateway_argv(argv) or (platform is not None and name not in LOCAL_PLATFORMS)
    if mode in ("0", "false", "no", "off"):
        gateway = False
    if gateway:
        _approval.ensure_poller()
        _approval.kick()
        return "thread"
    _approval.kick()
    return "pass"


def _on_session_start(**kwargs: Any) -> None:
    maybe_start(kwargs.get("platform"))


__all__ = [
    "CLASSES",
    "INFERRED_CLASS",
    "LIVE",
    "Outcome",
    "STATED_CLASS",
    "SUMMARIES",
    "active",
    "advance",
    "approval_of",
    "is_live",
    "key_for",
    "maybe_start",
    "open_entry",
    "payload_for",
    "run_intent_pass",
    "set_emitter",
    "summary_for",
    "withdraw_local",
]
