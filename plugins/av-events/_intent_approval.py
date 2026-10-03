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
most 262144 bytes): the bytes the resident is shown and grants. That string
is already its own RFC 8785 canonical form (one string key; Python's escaping
of a string without lone surrogates, which the tool refuses, is JCS's), so its
plain SHA-256 is the `payload_hash` core registers, and the plugin checks it
against the hash core answers before it ever starts or publishes.

**Where the text is held (R16).** The payload string is kept in the plugin's
own map (`$HERMES_HOME/av-events/intentions.json`, 0600, under the map's
flock) as `approval.payload` on the intention's entry, from capture until the
proposal ends: it is deleted when the intention is published, when Index
refuses it (422), when the publish is ambiguous or fails, when the resident
rejects it, when the agent withdraws it, and when it expires for the last
time. A proposal core refuses (`class-not-agent-requestable` and kin) keeps
it, so a `confirm` after the policy changes can file it again. It never
appears in a log line, an event, or the summary.

**What authorizes a publish (and nothing else does).** The map is never
authority: it says only what to ask the daemon next. A publish happens only
in the same call that

1. read the authority from the daemon for THAT key: `wait --timeout 0` exit 0
   with `status: granted` for a manual class; for a class the policy clears,
   the `propose` answer `decision: autonomous|supervised` with no execution
   yet (a rule approval writes no grant, so there is no `wait` to read);
2. claimed the entry atomically (`requested|cleared -> starting`, a
   compare-and-set under the map's flock, with a claim id);
3. read the same authority from the daemon again, after the claim;
4. got `start` back ok with `authorization` `grant` (manual) or `policy`
   (cleared), exactly the one expected;
5. checked that the held bytes still hash to the registered `payload_hash`,
   then moved the entry `starting -> publishing` under the claim, and sent
   `json.loads(payload)["text"]`, the very string `start` was given.

Every other `wait` answer is not a grant: exit 0 with any other status
(`nothing-to-wait-for`, `executed`), exit 1 (rejected, revoked, withdrawn,
`not-registered`), 3 (expired), 6 (pending), 7 (void), and anything else.

**States** (`approval.state`; every transition is a compare-and-set):

    unfiled    --propose--> requested | cleared | rejected | refused |
                            start_unconfirmed (core says it already executed)
    requested  --wait 0--> (granted) claim, re-read, start, publish |
                            rejected | withdrawn | unfiled (expired: the same
                            bytes re-proposed at most twice; void after a
                            policy re-attest; a task the log no longer knows)
                            | start_unconfirmed (nothing-to-wait-for)
    cleared    --claim, re-propose, start, publish
    starting   older than STALE_STARTING_S: released to where it came from;
               the daemon is asked again (a start that landed reads
               nothing-to-wait-for / executed: start_unconfirmed)
    publishing older than STALE_PUBLISHING_S: ambiguous, never sent again
    published | index_rejected | ambiguous | index_failed | start_unconfirmed
               | rejected | withdrawn | expired: final

**No duplicate publish, no publish of a withdrawn intention.** Only the
holder of the `starting` claim can start and publish, the claim is taken
before the authority is re-read, and the agent's withdraw is refused while an
entry is `starting` or `publishing`. `publishing` is written before the Index
request; a process that died inside it leaves an entry that becomes
`ambiguous` (`publish_refused: timeout`, reconciled by `sourceId` and text
hash) and is never sent again. A start whose confirmation was lost is never
published on the strength of the map or of an answer other than a fresh
`start` ok: it ends `start_unconfirmed`, and the intention is not published
(capture it again). A definite non-write from Index (nothing reached it) is
tried once more in the same call, under the cap, and otherwise ends
`index_failed`: a retry in a later call would publish on a `start` it no
longer holds.

**A stale grant after a policy re-attest.** `wait` answers `void` (exit 7)
and `start` refuses `policy-drift`; both re-propose the same bytes, which
core files as a new question under the new policy.

**Events.** A publish (or a refusal) that happens inside the capture call is
reported in the tool's result, and the observer emits the one
`intention.captured`. One that happens later (the poller, or `confirm`) is
emitted here as `intention.updated` with `index_intent_id`, `approved_by`
(`individual` for a human's grant, `rule` for the policy) and
`approval_state`, through the emitter the plugin registers (`set_emitter`).

Python 3.11, standard library only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sys
from typing import Any, Callable, Optional

from . import _approval
from ._core import env, uuid7

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
#: States in which there is still something to ask the daemon or to finish.
LIVE = frozenset({"unfiled", "requested", "cleared", "starting", "publishing"})
#: Final states that drop the held text.
TERMINAL_DROP = frozenset({
    "published", "rejected", "withdrawn", "index_rejected", "ambiguous", "index_failed",
    "start_unconfirmed", "expired",
    # Refuter round (B1, S1): the agent re-worded a refused proposal; a map
    # entry whose class or key is not one this module writes; a proposal the
    # policy clears that no capture call is there to execute.
    "superseded", "invalid", "not_published",
})

MAX_PAYLOAD_BYTES = 262144
MAX_EXPIRED_REPROPOSALS = 2
#: Each one needs a human to re-attest the policy; the cap only stops a loop.
MAX_VOID_REPROPOSALS = 10
MAX_STEPS = 10
MAX_PER_PASS = 50
#: A tool call that is advancing an entry itself keeps the poller off it.
INLINE_GRACE_S = 90.0
#: A claim covers two daemon calls (the re-read and `start`) of at most
#: `_approval.REQUEST_TIMEOUT_S` each; one older than this was abandoned.
STALE_STARTING_S = 120.0
#: Codes for which nothing reached Index (see `_record_intention.status_code`):
#: worth one more attempt inside the same call.
RETRY_ONCE = frozenset({"transport", "http_503", "http_429"})

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
    """`{"text": ...}` as compact JSON (its own JCS form), or None when it is
    over core's limit."""
    payload = json.dumps({"text": text}, ensure_ascii=False, separators=(",", ":"))
    return payload if len(payload.encode("utf-8")) <= MAX_PAYLOAD_BYTES else None


def payload_hash(payload: Any) -> Optional[str]:
    """SHA-256 of the held string as sent: core's `payload_hash` for it."""
    if not isinstance(payload, str):
        return None
    try:
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()
    except UnicodeEncodeError:
        return None


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


def holds_text(entry: Optional[dict]) -> bool:
    """A live proposal, or a refused one (which keeps its text for `confirm`)."""
    ap = approval_of(entry)
    return ap is not None and (ap.get("state") in LIVE or ap.get("state") == "refused")


def valid_shape(intention_id: str, ap: dict) -> bool:
    """S1: the class is one of ours and the key is exactly `<class>:<intention_id>`.
    The map is the agent's to write (same uid); nothing it names is trusted."""
    cls = ap.get("class")
    return cls in CLASSES and ap.get("key") == key_for(cls, intention_id)


def _invalid(intention_id: str, expect) -> Outcome:
    _set_state(intention_id, expect, "invalid", code="map_invalid")
    logger.warning("av-events: approval map_invalid")
    return Outcome("invalid", code="map_invalid")


# ---- Map transitions ------------------------------------------------------


def _cas(intention_id: str, expect: Optional[frozenset[str] | set[str] | tuple[str, ...]],
         change: Callable[[dict, dict], None], *, claim: Optional[str] = None) -> Optional[dict]:
    """Under the map lock: when the entry's approval state is in `expect` (any
    state when None) and, with `claim`, the entry still carries that claim id,
    apply `change(entry, approval)` and save. The entry after, else None."""
    ri = _ri()
    try:
        with ri._Locked():
            entries, publishes = ri._load_locked()
            entry = entries.get(intention_id)
            ap = approval_of(entry)
            if ap is None or (expect is not None and ap.get("state") not in expect):
                return None
            if claim is not None and ap.get("claim") != claim:
                return None
            change(entry, ap)
            ap["updated_at"] = float(ri._clock())
            if ap.get("state") not in ("starting", "publishing"):
                ap.pop("claim", None)
                ap.pop("claimed_at", None)
                ap.pop("back", None)
            if ap.get("state") in TERMINAL_DROP:
                ap.pop("payload", None)
                ap.pop("inline_until", None)
            ri._save_locked(entries, publishes)
            return json.loads(json.dumps(entry))
    except Exception as exc:  # noqa: BLE001 - a map that cannot be written moves nothing
        logger.warning("av-events: approval map_write_failed=%s", type(exc).__name__)
        return None


def _set_state(intention_id: str, expect, state: str, *, claim: Optional[str] = None, **fields: Any) -> Optional[dict]:
    def change(_entry: dict, ap: dict) -> None:
        ap["state"] = state
        for name, value in fields.items():
            if value is None:
                ap.pop(name, None)
            else:
                ap[name] = value

    return _cas(intention_id, None if expect is None else frozenset(expect), change, claim=claim)


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


# ---- Reading the daemon ---------------------------------------------------


def _granted(task: str) -> tuple[bool, Optional["_approval.Answer"], Optional[str]]:
    """`wait --timeout 0` for one task: (granted, the answer, a code). Granted
    means exit 0 AND `status: granted`, nothing else."""
    try:
        answer = _approval.wait(task)
    except _approval.ApprovalUnavailable as exc:
        return False, None, exc.code
    return answer.exit_code == 0 and answer.status == "granted", answer, None


def _cleared(ap: dict) -> tuple[bool, Optional[str]]:
    """The same `propose` again (idempotent): the policy still clears this key,
    nothing has executed it, and core's hash is the held bytes' hash."""
    try:
        answer = _approval.propose(ap["class"], ap["key"], summary_for(ap["class"], ap["key"].split(":", 1)[1]),
                                   ap["payload"])
    except _approval.ApprovalUnavailable as exc:
        return False, exc.code
    if not answer.ok:
        return False, answer.error_code or f"exit_{answer.exit_code}"
    doc = answer.doc
    if doc.get("payload_hash") != ap.get("payload_hash") or payload_hash(ap.get("payload")) != ap.get("payload_hash"):
        return False, "payload_hash_mismatch"
    if doc.get("decision") not in ("autonomous", "supervised") or doc.get("state") is not None:
        return False, f"decision_{doc.get('decision')}_{doc.get('state')}"
    return True, None


# ---- Advancing one proposal -----------------------------------------------


def _propose(intention_id: str, ap: dict) -> Optional[Outcome]:
    """unfiled -> the state core's answer names. None to continue the loop."""
    if not valid_shape(intention_id, ap):
        return _invalid(intention_id, {"unfiled"})
    payload = ap.get("payload")
    try:
        answer = _approval.propose(ap["class"], ap["key"], summary_for(ap["class"], intention_id), payload)
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
    if task is None or not task.startswith("propose:"):
        _note_code(intention_id, "bad_answer")
        return Outcome("unfiled", code="bad_answer")
    registered = doc.get("payload_hash")
    if not isinstance(registered, str) or registered != payload_hash(payload):
        # The bytes held here are not the bytes core registered for this key.
        _set_state(intention_id, {"unfiled"}, "refused", code="payload_hash_mismatch", task=task)
        logger.warning("av-events: approval payload_hash_mismatch")
        return Outcome("refused", code="payload_hash_mismatch", task=task)
    decision, state = doc.get("decision"), doc.get("state")
    if state == "executed":
        new, stop = "start_unconfirmed", True
    elif decision == "requested":
        if state in ("requested", "granted"):
            # A grant is read from `wait`, never from this answer.
            new, stop = "requested", state == "requested"
        else:
            new, stop = "rejected", True
    elif decision in ("autonomous", "supervised") and state is None:
        new, stop = "cleared", False
    else:
        _note_code(intention_id, "bad_answer")
        return Outcome("unfiled", code="bad_answer")
    _set_state(intention_id, {"unfiled"}, new, task=task, payload_hash=registered, code=None)
    return Outcome(new, task=task) if stop else None


def _repropose(intention_id: str, kind: str, cap: int, expect: set[str], claim: Optional[str] = None) -> Optional[Outcome]:
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

    after = _cas(intention_id, frozenset(expect), change, claim=claim)
    ap = approval_of(after)
    if ap is not None and ap.get("state") == "expired":
        return Outcome("expired", code=kind)
    return None


def _poll(intention_id: str, ap: dict, execute: bool = True) -> Optional[Outcome]:
    """requested: the daemon's answer for this key, and on a grant, execute."""
    task = ap.get("task")
    if not isinstance(task, str):
        _set_state(intention_id, {"requested"}, "unfiled")
        return None
    granted, answer, code = _granted(task)
    if answer is None:
        _note_code(intention_id, code or "transport")
        return Outcome("requested", code=code, task=task)
    if granted:
        if not execute:
            # S3: a one-shot resume pass outside the gateway stops before start.
            return Outcome("requested", code="deferred", task=task)
        return _execute(intention_id, ap, "grant")
    exit_code, status = answer.exit_code, answer.status
    if exit_code == 6:
        return Outcome("requested", task=task)
    if exit_code == 0:
        if status in ("executed", "nothing-to-wait-for"):
            # The grant is spent, and only this actor can spend it: a start of
            # ours whose confirmation was lost. Not a grant; never published.
            _set_state(intention_id, {"requested"}, "start_unconfirmed", code=status)
            return Outcome("start_unconfirmed", code=status, task=task)
        _note_code(intention_id, f"wait_status_{status}")
        return Outcome("requested", code="not_granted", task=task)
    # S4: an exit code counts only together with the status that names it;
    # anything else is transient (asked again next pass).
    if exit_code == 1 and answer.error_code == "not-registered":
        _set_state(intention_id, {"requested"}, "unfiled", code="not-registered")
        return None
    if exit_code == 1 and status in ("rejected", "revoked", "withdrawn"):
        terminal = "withdrawn" if status == "withdrawn" else "rejected"
        _set_state(intention_id, {"requested"}, terminal, code=status)
        return Outcome(terminal, task=task)
    if exit_code == 3 and status == "expired":
        return _repropose(intention_id, "expired", MAX_EXPIRED_REPROPOSALS, {"requested"})
    if exit_code == 7 and status == "void":
        return _repropose(intention_id, "void", MAX_VOID_REPROPOSALS, {"requested"})
    _note_code(intention_id, f"wait_exit_{exit_code}")
    return Outcome("requested", code="not_granted", task=task)


def _release(intention_id: str, claim: str, back: str, code: str) -> Outcome:
    _set_state(intention_id, {"starting"}, back, claim=claim, code=code)
    return Outcome(back, code=code)


def _execute(intention_id: str, ap: dict, kind: str) -> Optional[Outcome]:
    """Claim, re-read the authority, start, publish. `kind` is `grant` (a
    manual class, just read granted) or `policy` (a class the policy clears)."""
    ri = _ri()
    back = "requested" if kind == "grant" else "cleared"
    if not valid_shape(intention_id, ap):
        return _invalid(intention_id, {back})
    expected = "grant" if kind == "grant" else "policy"
    payload = ap.get("payload")
    if payload_hash(payload) is None or payload_hash(payload) != ap.get("payload_hash"):
        # The held bytes changed since core registered them: never publish
        # them; propose again (core refuses other bytes for the key).
        _set_state(intention_id, {back}, "unfiled", code="payload_hash_mismatch")
        return None
    code = ri._publish_precheck()
    if code is None:
        code = ri.reserve_publish()
    if code is not None:
        _note_code(intention_id, code)
        return Outcome(back, code=code)
    claim = uuid7()
    now = float(ri._clock())
    def take(_entry: dict, apx: dict) -> None:
        apx["state"] = "starting"
        apx["claim"] = claim
        apx["back"] = back
        apx["claimed_at"] = now
        apx.pop("code", None)

    # One compare-and-set: only one caller moves `back -> starting`, and every
    # later step checks this claim id. Then the authority is read again.
    if _cas(intention_id, {back}, take) is None:
        return Outcome("starting")
    task = ap.get("task")
    if kind == "grant":
        ok, answer, why = _granted(task)
        if not ok:
            if answer is not None and answer.exit_code == 7 and answer.status == "void":
                return _repropose(intention_id, "void", MAX_VOID_REPROPOSALS, {"starting"}, claim=claim)
            return _release(intention_id, claim, back, why or f"wait_exit_{answer.exit_code if answer else 'none'}")
    else:
        ok, why = _cleared(ap)
        if not ok:
            # Ask from the start: the class may be manual now, or executed.
            _set_state(intention_id, {"starting"}, "unfiled", claim=claim, code=why)
            return None
    try:
        answer = _approval.start(task, ap["key"], payload)
    except _approval.ApprovalUnavailable as exc:
        # Whether it landed is unknown: the next read of the daemon tells
        # (a spent grant reads nothing-to-wait-for, and is never published).
        return _release(intention_id, claim, back, exc.code)
    if not answer.ok:
        error = answer.error_code or f"exit_{answer.exit_code}"
        if error == "already-executed":
            _set_state(intention_id, {"starting"}, "start_unconfirmed", claim=claim, code=error)
            return Outcome("start_unconfirmed", code=error)
        if error == "policy-drift":
            return _repropose(intention_id, "void", MAX_VOID_REPROPOSALS, {"starting"}, claim=claim)
        if error == "expired":
            return _repropose(intention_id, "expired", MAX_EXPIRED_REPROPOSALS, {"starting"}, claim=claim)
        if error in REFUSED_CODES:
            _set_state(intention_id, {"starting"}, "refused", claim=claim, code=error)
            return Outcome("refused", code=error)
        return _release(intention_id, claim, back, error)
    authorization = answer.doc.get("authorization")
    if authorization != expected:
        # An execution is recorded, but not on the authority this call read.
        _set_state(intention_id, {"starting"}, "refused", claim=claim, code="authorization_mismatch")
        logger.warning("av-events: approval authorization_mismatch")
        return Outcome("refused", code="authorization_mismatch")
    if _set_state(intention_id, {"starting"}, "publishing", claim=claim, authorization=authorization,
                  publishing_at=float(ri._clock())) is None:
        return Outcome("starting")
    return _publish(intention_id, payload, ap.get("payload_hash"), authorization, claim, ap["key"])


def _publish(intention_id: str, payload: str, registered: Any, authorization: str, claim: str,
             key: str) -> Outcome:
    ri = _ri()
    key_id = key.split(":", 1)[1]
    text = text_of(payload)
    if text is None or payload_hash(payload) != registered:
        _set_state(intention_id, {"publishing"}, "refused", claim=claim, code="payload_hash_mismatch", publishing_at=None)
        return Outcome("refused", code="payload_hash_mismatch", authorization=authorization)
    code: Optional[str] = None
    for attempt in range(2):
        if attempt:
            code = ri._publish_precheck() or ri.reserve_publish()
            if code is not None:
                break
        # S1: the sourceId is the key's own id (valid_shape made it this entry's).
        index_id, code = ri.publish_intent(text, source_id=key_id)
        if index_id is not None:
            def change(entry: dict, apx: dict) -> None:
                apx["state"] = "published"
                apx.pop("code", None)
                apx.pop("publishing_at", None)
                entry["published"] = True
                entry["index_intent_id"] = index_id
                entry.pop(ri.HELD_HASH_KEY, None)

            _cas(intention_id, {"publishing"}, change, claim=claim)
            return Outcome("published", index_intent_id=index_id, authorization=authorization)
        if code == "rejected":
            def change_rejected(entry: dict, apx: dict) -> None:
                apx["state"] = "index_rejected"
                apx["code"] = "rejected"
                apx.pop("publishing_at", None)
                entry["refused"] = "rejected"
                entry.pop(ri.HELD_HASH_KEY, None)

            _cas(intention_id, {"publishing"}, change_rejected, claim=claim)
            return Outcome("index_rejected", code="rejected", authorization=authorization)
        if code == ri.AMBIGUOUS:
            _set_state(intention_id, {"publishing"}, "ambiguous", claim=claim, code=code, publishing_at=None)
            return Outcome("ambiguous", code=code, authorization=authorization)
        if code not in RETRY_ONCE:
            break
    # Nothing reached Index, and the start this call holds is spent on it.
    _set_state(intention_id, {"publishing"}, "index_failed", claim=claim, code=code, publishing_at=None)
    return Outcome("index_failed", code=code, authorization=authorization)


def _stale(intention_id: str, ap: dict, emit: bool, entry: Optional[dict]) -> Optional[Outcome]:
    ri = _ri()
    state = ap.get("state")
    now = float(ri._clock())
    if state == "starting":
        at = ap.get("claimed_at")
        if isinstance(at, (int, float)) and now - float(at) <= STALE_STARTING_S:
            return Outcome("starting")
        back = ap.get("back") if ap.get("back") in ("requested", "cleared") else "requested"
        # Abandoned before Index was called: ask the daemon again from there.
        _set_state(intention_id, {"starting"}, back, claim=ap.get("claim"), code="claim_abandoned")
        return None
    at = ap.get("publishing_at")
    if isinstance(at, (int, float)) and now - float(at) <= STALE_PUBLISHING_S():
        return Outcome("publishing")
    # B1 discipline: Index may have written. Never sent again.
    if _set_state(intention_id, {"publishing"}, "ambiguous", claim=ap.get("claim"), code=ri.AMBIGUOUS,
                  publishing_at=None):
        result = Outcome("ambiguous", code=ri.AMBIGUOUS, authorization=ap.get("authorization"))
        if emit:
            _emit(intention_id, entry, ap, result)
        return result
    return None


#: Outcomes worth an `intention.updated` when no tool result carries them.
EMITTED = frozenset({"published", "index_rejected", "ambiguous", "index_failed"})


def advance(intention_id: str, *, emit: bool, inline: bool = False, expect_class: Optional[str] = None,
            execute: bool = True) -> Outcome:
    """Take the proposal as far as the daemon's answers allow now. Never raises.

    `emit`: report a publish (or Index's refusal) as `intention.updated` here,
    because no tool result will carry it. `inline`: the capture call itself is
    advancing; the poller is kept off meanwhile. `expect_class`: the class
    the capture call has in memory; only such a call executes a start the
    policy clears (S1), and only for that class. `execute`: False for a
    one-shot resume pass outside the gateway, which stops before `start` (S3).
    """
    ri = _ri()
    try:
        for _ in range(MAX_STEPS):
            entry = ri.lookup(intention_id)
            ap = approval_of(entry)
            if ap is None:
                return Outcome("none")
            ap = dict(ap)
            state = ap.get("state")
            until = ap.get("inline_until")
            if not inline and isinstance(until, (int, float)) and until > float(ri._clock()):
                return Outcome(state or "unknown")
            if state == "published" and not (isinstance(entry, dict) and entry.get("published") is True):
                # A map that says published without the publish this module records.
                return Outcome("inconsistent", code="map_inconsistent")
            if state not in LIVE:
                return Outcome(state or "unknown", code=ap.get("code"), task=ap.get("task"),
                               index_intent_id=entry.get("index_intent_id") if isinstance(entry, dict) else None,
                               authorization=ap.get("authorization"))
            if state == "unfiled":
                result = _propose(intention_id, ap)
            elif state == "requested":
                result = _poll(intention_id, ap, execute)
            elif state == "cleared":
                if inline and execute and expect_class is not None and ap.get("class") == expect_class:
                    result = _execute(intention_id, ap, "policy")
                else:
                    # S1: the poller and `confirm` publish only on a human grant.
                    _set_state(intention_id, {"cleared"}, "not_published", code="rule_needs_capture")
                    result = Outcome("not_published", code="rule_needs_capture")
            else:
                result = _stale(intention_id, ap, emit, entry)
                if result is not None:
                    return result
                continue
            if result is not None:
                if emit and result.state in EMITTED:
                    _emit(intention_id, entry, ap, result)
                return result
        return Outcome("unknown")
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
    done (or there was none), `approval_publishing` while a claimed start or
    the Index call is in flight. A pending question is withdrawn on the
    daemon, best effort."""
    entry = _ri().lookup(intention_id)
    ap = approval_of(entry)
    if ap is None or not holds_text(entry):
        return None
    if ap.get("state") in ("starting", "publishing"):
        return "approval_publishing"
    previous = ap.get("state")
    task = ap.get("task")
    # B1: a refused proposal ends too (its held text goes), so no later
    # `confirm` can reopen it.
    after = _set_state(intention_id, {"unfiled", "requested", "cleared", "refused"}, "withdrawn",
                       code="agent_withdrew")
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


def abandon(intention_id: str, code: str) -> None:
    """S1: a stated capture that could not be proposed now is not published later."""
    _set_state(intention_id, {"unfiled", "cleared"}, "not_published", code=code)


def supersede(intention_id: str) -> bool:
    """B1: an update of a refused proposal ends it (the held text goes); the
    new words are a new capture's to propose."""
    return _set_state(intention_id, {"refused"}, "superseded", code="agent_updated") is not None


def reopen(intention_id: str) -> bool:
    """`confirm` on a proposal core refused (`class-not-agent-requestable` and
    kin), whose held text was kept: file it again, in case the policy changed.
    True when it was reopened."""
    def change(_entry: dict, ap: dict) -> None:
        ap["state"] = "unfiled"
        ap.pop("code", None)

    return _cas(intention_id, {"refused"}, change) is not None


# ---- The pass and the poller ----------------------------------------------


def run_intent_pass(execute: bool = True) -> None:
    """Advance every live proposal once (at most `MAX_PER_PASS`). `execute`
    False (a one-shot resume pass outside the gateway): stop before `start`."""
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
        outcome = advance(intention_id, emit=True, execute=execute)
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
    if platform is None:
        # S3: plugin registration outside `hermes gateway run` kicks nothing.
        return "idle"
    _approval.kick()  # a one-shot pass that stops before `start`
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
    "payload_hash",
    "run_intent_pass",
    "set_emitter",
    "summary_for",
    "withdraw_local",
]
