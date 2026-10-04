"""Sharing a digest and casting the weekly vote through approval.md (lane O3).

Two resident-approved actions on Lane B's approval client and poller
(`_approval`), each behind its own switch and both inert unless approval is
configured (`AV_APPROVAL_ENABLED` on, `AV_APPROVAL_URL` set):

- `share_digest` (`AV_DIGEST_SHARE`): the agent proposes a short text for
  village services to read, with a scope and an expiry, in class
  `digest.share`; on the resident's grant the plugin records `start` and
  emits `digest.shared@1`. The resident can later revoke it: the agent, on
  the resident's instruction, calls the tool again, and the plugin emits
  `digest.revoked@1` (DATA-96 §5 step 5: "a resident can revoke"; no
  approval: the policy rows name no revoke class, and narrowing a share is
  the safe direction). Nothing else revokes: an expiry needs no event (the
  ODS writer drops a lapsed share itself), and the daemon has no withdrawal
  of an executed share.
- `village_vote` (`AV_VILLAGE_VOTE`): the agent proposes the resident's
  answer to the open weekly question in class `village.vote`; on the
  resident's grant (or, where the resident set the class autonomous, inside
  the tool call itself) `start` and `vote.cast@1`.

The contract is the data repo's `docs/spec-addenda.md` "digest.* and
vote.cast" and the three closed schemas. What it fixes here:

- **Keys.** `digest.share:<digest_id>` (`digest_id` a uuid4 the plugin
  mints) and `village.vote:<question_id>:<tenant_id>` (the tenant the ingest
  token belongs to: `AV_TENANT_ID`, else `TENANT_ID`, process environment
  only, lower-cased and required to be a UUID as the collector requires).
- **The proposed bytes.** Exactly `{digest_id, scope, text, expires_at}` or
  `{question_id, answer}`, as RFC 8785 canonical JSON (sorted keys, no
  whitespace, UTF-8, the escapes JCS and Python share), so the plain SHA-256
  of the held string is the `payload_hash` core registers and the one the
  door recomputes. A vote's rationale goes in the proposal's summary, never
  the payload. A share's summary names its scope, expiry and id, never its
  text.
- **The event**, emitted only after `start` answered ok: the proposed object
  plus `idempotency_key` (SHA-256 of the key), `payload_hash` (from
  `propose`, checked against the held bytes), `start_seq` (`start`'s `seq`)
  and `authorization` (`start`'s; a share admits only `grant`, so a share
  the policy clears is never started). No `decision_id` and no
  `policy_version` (the plugin cannot know either). Actor `agent`, no
  session, envelope `decision_id` null, `agent_report`.
- **A share's expiry** is set when it is proposed, at most 7 days less an
  hour after the plugin's clock (the door refuses one more than 7 days after
  it receives the event, with no skew allowance), and a share with less than
  10 minutes left is neither started nor sent.

**What authorizes an event, and nothing else does.** The map is never
authority: the agent runs as the plugin's uid and can write it. It says only
what to ask the daemon next. An event is emitted only by the one call that
(1) read the grant from the daemon for that key in that call (`wait
--timeout 0` exit 0 `status: granted`), or, for a vote the policy clears, the
`propose` answer itself inside the vote's own tool call; (2) claimed the
entry with one compare-and-set (a claim id); (3) read the same authority
again after the claim; (4) got `start` ok for exactly those bytes, naming
this key and class, with the expected `authorization` and a `seq`; (5) built
the event from the very string it sent to `start` (never from the map), and
found the map still holding those bytes, the hash core answered at `propose`
and its claim. A pending, rejected, revoked, withdrawn, expired or void
answer, a daemon that cannot be reached or verified, a refused start, or a
map that changed under the call is no event. An `emitting` entry the pass
meets is never sent from there: it is the call in flight, or one that died
(`emit_unconfirmed`).

**What the resident approves is what is sent.** One function (`canonical`)
makes the proposed bytes; `start` is given that same string; `start` ok means
core found it hashing to the binding the resident was asked about; the event
is one parse of it, and its `payload_hash` is that string's SHA-256, which
must also equal the hash core answered at `propose`.

**Where the held text lives.** The proposed string (with a share's text) is
kept in `$HERMES_HOME/av-events/share-vote.json` (0600, under its flock)
from the tool call until the proposal ends, and dropped then; a shared
digest keeps its id, scope and expiry (for a revocation), never its text.
The text is never in a summary, a log line or an error.

**No duplicate event.** Only the holder of the claim emits, once; nothing
re-emits. The event id is a uuid v7 derived from the start time, the key
and `start_seq`. A spent grant whose `start` answer was lost ends
`start_unconfirmed`, and an event nothing could carry after its start ends
`emit_failed`: neither is ever sent later.

**A revocation** is emitted in the tool call the resident's instruction
causes, needs no approval, and is sent once per share (claimed in the map
first, put back when nothing carried it).

**The vote is bound to the provider's question, not the map's.** Before a
vote is proposed and again before it is started (ahead of the claim), the
provider is asked: the entry's `question_id` must be the open question's,
its answer one of that question's option keys, and the question not closed
by the provider's own `closes_at`. Otherwise the entry ends (`closed` with
`question_unavailable` or `question_closed`, or `invalid` with
`answer_not_an_option`), a pending question is withdrawn, and nothing is
sent. Under the shipped provider no vote is ever proposed.

**What the resident reads.** A vote's prompt is built from the provider: the
question's text and the chosen option's label (one line, bounded, controls,
format and bidi characters dropped), or a plain statement that no text or
label is available beside the option key. The agent's rationale follows,
cleaned again and labelled as the agent's note; it is dropped when it fails
cleaning or quotes a share this agent still holds, and refused at the tool
for the same reasons. A share's prompt names scope, expiry and id only.
approval.md renders the summary as Telegram HTML with `& < >` escaped, under
its "claimed" heading; against what that still allows (line breaks, links,
mentions and commands Telegram detects itself, look-alike letters) the
rationale is held to a conservative character set (`rationale_charset`),
and one function (`display_line`) defines a prompt line for trusted text and
the rationale alike. The summary string built once is the one checked,
measured against 4096 bytes and passed to `propose`.

**Accepted limits (in writing).**

- A revocation needs no approval because it only reduces exposure. The
  agent can therefore revoke, or (by writing the map) pre-revoke, any digest
  id of its own tenant. The data side keys a revocation on the token's
  tenant, so no other resident is reachable. A revocation is sent at most
  once per digest id per process, and only for an entry this module marked
  sent (`emitted` with its event id, start seq and `grant`); the map can
  still be forged to look like that.
- The agent runs as the plugin's uid. It can write the event spool directly,
  and an agent that can start a Hermes process controls that process's
  environment (Hermes loads `.env` with override at startup), so the
  switches and `AV_APPROVAL_URL` too, and could point the plugin at a
  listener of its own (the loopback listener check binds only the uid the
  environment names). The defence for both is the data side's: the ODS
  writer resolves every share and vote against the approval follower's own
  rows, which this sandbox does not write.
- What reaches the village: the tools refuse up front, proposing nothing,
  when no event could be sent (no token, the plugin off, a null sink) or
  when ingest says the tenant is not in the research (the worker drops these
  events). When consent cannot be read, the tool proceeds, and its answers
  say only that the event was handed to the event queue, never that it was
  delivered.

**The weekly question** comes from `_village_question.current_question()`,
whose shipped implementation refuses (`question_source_not_built`): the
contract's source, `ods.questions`, does not exist yet.

Python 3.11, standard library only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import time
import unicodedata
import uuid
from typing import Any, Callable, Optional

try:  # POSIX
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

from . import _approval
from . import _village_question as vq
from ._core import DIR_MODE, FILE_MODE, derived_uuid7, epoch_from_iso, hermes_home, iso_from_epoch, sanitize, uuid7

logger = logging.getLogger("av-events")

SHARE_CLASS = "digest.share"
VOTE_CLASS = "village.vote"
CLASSES = (SHARE_CLASS, VOTE_CLASS)

SHARE_SWITCH = "AV_DIGEST_SHARE"
VOTE_SWITCH = "AV_VILLAGE_VOTE"
TRUTHY = frozenset({"1", "true", "yes", "on"})

SHARE_TOOL = "share_digest"
VOTE_TOOL = "village_vote"
TOOLSET = "av-events"

SHARED_EVENT = "digest.shared"
REVOKED_EVENT = "digest.revoked"
VOTE_EVENT = "vote.cast"

MAP_FILE = "share-vote.json"
MAX_MAP_ENTRIES = 2000

#: `digest.shared@1`'s text: at most 500 code points (`DIGEST_TEXT_MAX_CHARS`).
DIGEST_TEXT_MAX = 500
#: The door's bound (`DIGEST_MAX_TTL_MS`): an expiry at most 7 days after it receives the event.
DIGEST_MAX_TTL_S = 7 * 24 * 3600
#: The emitter's own: an hour inside the door's, for clock skew and the spool.
MAX_TTL_S = DIGEST_MAX_TTL_S - 3600
MIN_TTL_S = 3600
DEFAULT_TTL_S = MAX_TTL_S
#: A share with less left than this is neither started nor sent.
MIN_REMAINING_S = 600.0
#: A vote is neither proposed nor started this close to the question's close.
CLOSE_MARGIN_S = 60.0
#: Open share proposals at once; the next is refused (the resident is not spammed).
MAX_PENDING_SHARES = 5
#: A vote's rationale, in the summary only: one line, bounded.
MAX_RATIONALE = 280
#: A rationale holding this many consecutive characters of a held share's
#: text (or all of a shorter one of at least `MIN_QUOTE`) is refused.
QUOTE_WINDOW = 24
MIN_QUOTE = 12
#: The question's text and an option's label, as the resident's prompt shows them.
MAX_PROMPT_QUESTION = 300
MAX_PROMPT_LABEL = 120
#: approval.md's `propose` limits (the contract Lane B was built against):
#: the summary at most 4 KiB and the key at most 1 KiB, UTF-8.
SUMMARY_MAX_BYTES = 4096
MAX_KEY_BYTES = 1024
ELLIPSIS = "\u2026"

#: The fixed words the vote prompt is built from. A rationale that contains
#: any of them (folded, punctuation ignored) is refused: it could pass for the
#: trusted part of the prompt.
PROMPT_HEAD = "Weekly village question"
PROMPT_NO_TEXT = "(no text for this question is available)."
PROMPT_ANSWER = "Answer to send for you:"
PROMPT_NO_LABEL = "(no description of this option is available)."
PROMPT_NOTE = "-- Note written by your agent (not part of the question):"
PROMPT_PHRASES = (PROMPT_HEAD, PROMPT_NO_TEXT, PROMPT_ANSWER, PROMPT_NO_LABEL, PROMPT_NOTE)
#: Characters that render blank without being whitespace (Hangul and
#: halfwidth fillers, the blank Braille pattern): dropped from a rationale.
BLANK_FILLERS = frozenset("\u115f\u1160\u3164\uffa0\u2800")

MAX_STEPS = 10
MAX_PER_PASS = 50
MAX_VOID_REPROPOSALS = 10
INLINE_GRACE_S = 90.0
STALE_STARTING_S = 120.0

DIGEST_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
RESERVED_IDS = frozenset({"00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"})
SCOPE = re.compile(r"^(village|service:[a-z][a-z0-9_-]{0,63})$")
LOWER_UUID = DIGEST_ID
_ENTRY_ID = re.compile(r"^(digest\.share:[0-9a-f-]{36}|village\.vote:[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128})$")

SHARE_KEYS = ("digest_id", "expires_at", "scope", "text")
VOTE_KEYS = ("answer", "question_id")

#: Codes core answers that end a proposal (Lane B's list).
REFUSED_CODES = frozenset({
    "class-not-agent-requestable", "class-human-only", "key-class-mismatch", "payload-too-large",
    "payload-mismatch", "duplicate-request", "task-not-proposal", "not-requester", "task-is-proposal",
    "usage",
})

#: States in which there is still something to ask the daemon or to send.
LIVE = frozenset({"unfiled", "requested", "cleared", "starting", "emitting"})
#: Final states; the held payload (and a vote's rationale) goes.
FINAL = frozenset({
    "emitted", "revoked", "rejected", "withdrawn", "expired", "refused", "start_unconfirmed", "lapsed",
    "closed", "not_shared", "not_cast", "invalid", "emit_refused", "emit_failed", "emit_unconfirmed",
})
#: An `emitting` entry older than this belongs to a call that died between the
#: buffer append and the map write: it is never sent again.
STALE_EMITTING_S = 60.0

_clock: Callable[[], float] = time.time

_emit_fn: Optional[Callable[..., bool]] = None
_ready_fn: Optional[Callable[[], bool]] = None


def set_emitter(emit: Optional[Callable[..., bool]], ready: Optional[Callable[[], bool]] = None) -> None:
    """The plugin's emitter: `emit(event_type, payload, event_id=, occurred_at=) -> bool`
    (True when the event was buffered) and `ready() -> bool` (it would be)."""
    global _emit_fn, _ready_fn
    _emit_fn = emit
    _ready_fn = ready


def _switch(name: str) -> bool:
    # Process environment only, like Lane B's own settings: never the `.env`
    # the agent can rewrite while it runs.
    return _approval.process_env(name).lower() in TRUTHY


def share_on() -> bool:
    return _switch(SHARE_SWITCH)


def vote_on() -> bool:
    return _switch(VOTE_SWITCH)


def active() -> bool:
    return _approval.configured() and (share_on() or vote_on())


def tenant_id() -> Optional[str]:
    """The tenant the ingest token belongs to, normalised as the collector
    normalises it (`_collector`: lower-case, and a UUID): a lower-case UUID,
    else None (the vote is refused)."""
    raw = (_approval.process_env("AV_TENANT_ID") or _approval.process_env("TENANT_ID")).lower()
    return raw if LOWER_UUID.fullmatch(raw) else None


# ---- The contract's pure parts ---------------------------------------------


def canonical(obj: dict) -> str:
    """RFC 8785 for an object of string values: sorted keys, no whitespace,
    UTF-8 as is, and the escapes Python's encoder and JCS share."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(text: Any) -> Optional[str]:
    if not isinstance(text, str):
        return None
    try:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()
    except UnicodeEncodeError:
        return None


def share_key(digest_id: str) -> str:
    return f"{SHARE_CLASS}:{digest_id}"


def vote_key(question_id: str, tenant: str) -> str:
    return f"{VOTE_CLASS}:{question_id}:{tenant}"


def share_payload(digest_id: str, scope: str, text: str, expires_at: str) -> str:
    return canonical({"digest_id": digest_id, "scope": scope, "text": text, "expires_at": expires_at})


def vote_payload(question_id: str, answer: str) -> str:
    return canonical({"question_id": question_id, "answer": answer})


def _noncharacter(cp: int) -> bool:
    return 0xFDD0 <= cp <= 0xFDEF or (cp & 0xFFFE) == 0xFFFE


def digest_text_problem(text: Any) -> Optional[str]:
    """None when `text` passes `digest.shared@1`'s text rule
    (`DIGEST_TEXT_PATTERN`), else a code. At most 500 code points, at least one
    letter or digit, and no C0/C1 control but tab, LF and CR; no U+2028/2029;
    no bidi embedding, override or isolate, nor U+206A-206F; no U+FEFF, U+2060
    or U+FFF9-FFFB; no surrogate, private-use character, noncharacter or tag."""
    if not isinstance(text, str) or not text:
        return "text_required"
    if len(text) > DIGEST_TEXT_MAX:
        return "text_too_long"
    letter_or_digit = False
    for ch in text:
        cp = ord(ch)
        if cp in (0x09, 0x0A, 0x0D):
            continue
        if cp <= 0x1F or 0x7F <= cp <= 0x9F or cp in (0x2028, 0x2029, 0x2060, 0xFEFF):
            return "text_invalid"
        if 0x202A <= cp <= 0x202E or 0x2066 <= cp <= 0x206F or 0xFFF9 <= cp <= 0xFFFB:
            return "text_invalid"
        if 0xD800 <= cp <= 0xDFFF or 0xE0000 <= cp <= 0xE007F or _noncharacter(cp):
            return "text_invalid"
        category = unicodedata.category(ch)
        if category == "Co":
            return "text_invalid"
        if category[0] in ("L", "N"):
            letter_or_digit = True
    return None if letter_or_digit else "text_no_letter_or_digit"


def shared_event_payload(payload: str, payload_hash: str, start_seq: int, authorization: str) -> Optional[dict]:
    """`digest.shared@1` from the held (granted) bytes and the link, or None
    when the bytes are not a share's."""
    obj = _parse(payload, SHARE_KEYS)
    if obj is None:
        return None
    return {
        "digest_id": obj["digest_id"],
        "scope": obj["scope"],
        "text": obj["text"],
        "expires_at": obj["expires_at"],
        "idempotency_key": sha256_hex(share_key(obj["digest_id"])),
        "payload_hash": payload_hash,
        "start_seq": start_seq,
        "authorization": authorization,
    }


def vote_event_payload(payload: str, tenant: str, payload_hash: str, start_seq: int, authorization: str) -> Optional[dict]:
    """`vote.cast@1` from the held (granted) bytes and the link, or None."""
    obj = _parse(payload, VOTE_KEYS)
    if obj is None:
        return None
    return {
        "question_id": obj["question_id"],
        "answer": obj["answer"],
        "idempotency_key": sha256_hex(vote_key(obj["question_id"], tenant)),
        "payload_hash": payload_hash,
        "start_seq": start_seq,
        "authorization": authorization,
    }


def revoked_event_payload(digest_id: str) -> dict:
    """`digest.revoked@1`: the id only (the plugin cannot name the decision)."""
    return {"digest_id": digest_id}


def _parse(payload: Any, keys: tuple[str, ...]) -> Optional[dict]:
    """The held string as an object with exactly `keys`, all strings, in its
    own canonical form; else None."""
    if not isinstance(payload, str):
        return None
    try:
        obj = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(obj, dict) or tuple(sorted(obj)) != keys or not all(isinstance(v, str) for v in obj.values()):
        return None
    try:
        if canonical(obj) != payload:
            return None
    except (TypeError, ValueError):
        return None
    return obj


#: Never shown on the resident's prompt: controls, format characters (bidi,
#: zero-width, joiners), surrogates, private-use and unassigned code points.
HIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn"})


def display_line(text: str) -> str:
    """The one definition of a prompt line, for trusted text and the
    rationale alike: every whitespace character (CR, LF, VT, FF, U+0085,
    U+2028, U+2029 and the Unicode spaces) becomes one plain space, hidden
    characters (`HIDDEN_CATEGORIES`) and blank-rendering fillers are dropped,
    and runs of spaces collapse. Applied once; what it returns is what is
    checked and what is sent."""
    kept = "".join(" " if ch.isspace() else ch for ch in text
                   if ch.isspace() or (ch not in BLANK_FILLERS and unicodedata.category(ch) not in HIDDEN_CATEGORIES))
    return " ".join(kept.split())


def one_line(text: Any, limit: int) -> Optional[str]:
    """Trusted text (a question, a label) as one bounded display line
    (`display_line`), cut at `limit` with an ellipsis. None when nothing is
    left."""
    if not isinstance(text, str):
        return None
    line = display_line(text)
    if not line:
        return None
    return line if len(line) <= limit else line[: limit - 1].rstrip() + ELLIPSIS


def utf8_len(text: str) -> int:
    return len(text.encode("utf-8"))


def fit_bytes(text: str, budget: int) -> str:
    """`text`, or its longest prefix plus an ellipsis, in at most `budget`
    UTF-8 bytes (never splitting a character). "" when not even that fits."""
    if utf8_len(text) <= budget:
        return text
    room = budget - utf8_len(ELLIPSIS)
    if room <= 0:
        return ""
    out, used = [], 0
    for ch in text:
        n = utf8_len(ch)
        if used + n > room:
            break
        out.append(ch)
        used += n
    return "".join(out).rstrip() + ELLIPSIS


def summary_for(entry: dict, question: Optional["vq.Question"] = None) -> str:
    """The line the resident reads and the daemon logs in cleartext.

    A share's names its scope, expiry and id: never its text. A vote's is
    built from the trusted provider's question (its text and the chosen
    option's label), never from anything the agent wrote; where the provider
    gives no text or label the prompt says so and shows the option key. The
    agent's rationale follows, cleaned again here and labelled as the agent's
    note; one that fails cleaning, or quotes a held share, is dropped and the
    prompt goes out without it."""
    if entry.get("class") == SHARE_CLASS:
        scope = entry.get("scope")
        # The only agent-chosen part: an ASCII service name ([a-z0-9_-]), quoted as a value.
        where = "the village" if scope == "village" else f"the village service \u201c{str(scope).split(':', 1)[-1]}\u201d"
        return fit_bytes(f"Share a digest your agent drafted with {where} until {entry.get('expires_at')} "
                         f"(digest {entry.get('digest_id')}).", SUMMARY_MAX_BYTES)
    answer = entry.get("answer")
    text = one_line(question.text, MAX_PROMPT_QUESTION) if question is not None else None
    option = question.option(answer) if question is not None and isinstance(answer, str) else None
    label = one_line(option.label, MAX_PROMPT_LABEL) if option is not None else None
    head = f"{PROMPT_HEAD} {entry.get('question_id')}: "
    if label:
        answer_line = f" {PROMPT_ANSWER} {label} (option {answer})."
    else:
        answer_line = f" {PROMPT_ANSWER} option {answer} {PROMPT_NO_LABEL}"
    # At most 4 KiB by construction: the answer line is kept whole, the
    # question's text is shortened first if the trusted part alone is too
    # long, and the agent's note gets only what is left.
    if text:
        quoted = "\u201c\u201d"
        text = fit_bytes(text, SUMMARY_MAX_BYTES - utf8_len(head) - utf8_len(answer_line) - utf8_len(quoted))
        middle = f"\u201c{text}\u201d" if text else PROMPT_NO_TEXT
    else:
        middle = PROMPT_NO_TEXT
    line = head + middle + answer_line
    rationale, problem = clean_rationale(entry.get("rationale"))
    if rationale and problem is None and not quotes_held_share(rationale):
        note = f" {PROMPT_NOTE} "
        room = SUMMARY_MAX_BYTES - utf8_len(line) - utf8_len(note)
        kept = fit_bytes(rationale, room) if room > 0 else ""
        if kept:
            line += note + kept
    return fit_bytes(line, SUMMARY_MAX_BYTES)


def _words(text: str) -> str:
    """Folded, with punctuation as spaces: how a rationale is compared with
    the prompt's own phrases."""
    return " ".join("".join(ch if ch.isalnum() else " " for ch in _fold(text)).split())


_PROMPT_WORDS = tuple(_w for _w in (" ".join("".join(c if c.isalnum() else " " for c in p.casefold()).split())
                                    for p in PROMPT_PHRASES) if _w)


def clean_rationale(value: Any) -> tuple[Optional[str], Optional[str]]:
    """(the rationale as one bounded line, None) or (None, a code).

    One cleaning (`display_line`), then every check on that same string,
    which is the one the summary carries. Refused: a format character of any
    kind (zero-width, bidi, joiners: `rationale_invisible`), a hidden
    character (`rationale_invalid`), a rationale that repeats any of the
    prompt's own fixed phrases (`rationale_imitates_prompt`), mixes Latin
    with a look-alike script (`rationale_mixed_script`), or leaves its
    character set (`rationale_charset`). Blank-rendering fillers are dropped
    and every kind of whitespace becomes one plain space."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, None
    if not isinstance(value, str):
        return None, "rationale_invalid"
    if any(unicodedata.category(ch) == "Cf" for ch in value):
        return None, "rationale_invisible"
    if any(not ch.isspace() and unicodedata.category(ch) in HIDDEN_CATEGORIES for ch in value):
        # Untrusted text is refused, never silently filtered, for anything
        # the prompt would not show.
        return None, "rationale_invalid"
    line = display_line(value)
    if not line:
        return None, None
    if len(line) > MAX_RATIONALE or digest_text_problem(line) is not None or sanitize(line) != line:
        return None, "rationale_invalid"
    words = _words(line)
    if any(phrase in words for phrase in _PROMPT_WORDS):
        return None, "rationale_imitates_prompt"
    if mixed_confusable_scripts(line):
        return None, "rationale_mixed_script"
    if rationale_charset_problem(line):
        return None, "rationale_charset"
    return line, None


#: The rationale's character set (conservative, by rule rather than by a
#: confusables table). Scripts whose letters it may use: Latin (only letters
#: whose decomposition starts with an ASCII letter: accented letters yes,
#: small capitals and other look-alike Latin no), and left-to-right Indic and
#: East Asian scripts. Cyrillic, Greek and other scripts that draw like Latin
#: are not on it, and neither are right-to-left scripts (no reordering of the
#: prompt around the note).
RATIONALE_SCRIPTS = frozenset({
    "LATIN", "DEVANAGARI", "BENGALI", "GURMUKHI", "GUJARATI", "ORIYA", "TAMIL", "TELUGU", "KANNADA",
    "MALAYALAM", "SINHALA", "CJK", "HIRAGANA", "KATAKANA", "HANGUL",
})
#: Punctuation it may use: no colon (no "Field: value" that reads as a new
#: row), and none of the characters that are markup or that Telegram turns
#: into a link, a mention, a tag, a command or a code span (`<>&@#/\*_[]{}|~`
#: and backtick, `$`, `%`, `+`, `=`, `^`).
RATIONALE_PUNCTUATION = frozenset(".,;!?'\"()-\u2018\u2019\u201c\u201d\u2013\u2014")
MAX_MARKS_IN_A_ROW = 3
MAX_DIGITS_IN_A_ROW = 6


def rationale_charset_problem(line: str) -> bool:
    """True when the (display-cleaned) rationale holds a character outside
    its set, a period inside a word (`evil.com` would become a link), more than
    `MAX_DIGITS_IN_A_ROW` digits together (a phone number), or more than
    `MAX_MARKS_IN_A_ROW` marks on one letter."""
    marks = digits = 0
    for i, ch in enumerate(line):
        cat = unicodedata.category(ch)
        marks = marks + 1 if cat in ("Mn", "Mc") else 0
        digits = digits + 1 if cat == "Nd" else 0
        if marks > MAX_MARKS_IN_A_ROW or digits > MAX_DIGITS_IN_A_ROW:
            return True
        if ch == " ":
            continue
        if ch in RATIONALE_PUNCTUATION:
            if ch == "." and i + 1 < len(line) and line[i + 1] != " ":
                return True
            continue
        if cat[0] not in ("L", "M", "N") or cat in ("Nl", "No"):
            return True
        if unicodedata.normalize("NFKC", ch) != ch:
            return True  # a compatibility form (full-width, mathematical, ligature)
        script = _script(ch)
        if cat == "Nd" and "0" <= ch <= "9":
            continue
        if script not in RATIONALE_SCRIPTS:
            return True  # COMBINING marks, look-alike and right-to-left scripts
        if script == "LATIN" and not ("a" <= unicodedata.normalize("NFKD", ch)[0].lower() <= "z"):
            return True
    return False


#: Scripts with letters drawn like Latin ones: mixed with Latin in one
#: rationale they can spell the prompt's own words with other code points.
CONFUSABLE_SCRIPTS = frozenset({"CYRILLIC", "GREEK", "ARMENIAN", "CHEROKEE", "COPTIC", "LISU", "OSAGE", "DESERET"})


def _script(ch: str) -> Optional[str]:
    try:
        return unicodedata.name(ch).split(" ", 1)[0]
    except ValueError:
        return None


def mixed_confusable_scripts(text: str) -> bool:
    """Latin letters together with letters of a script that draws like Latin
    (after compatibility folding, so full-width and mathematical forms count
    as Latin)."""
    scripts = {_script(ch) for ch in unicodedata.normalize("NFKD", text) if ch.isalpha()}
    return "LATIN" in scripts and bool(scripts & CONFUSABLE_SCRIPTS)


def _fold(text: str) -> str:
    """Compatibility-normalised, format and combining marks dropped, case-folded, spacing
    collapsed: zero-width or combining characters between the letters do not
    hide a quotation."""
    # NFKD: the compatibility mapping NFKC applies (full-width and other
    # compatibility forms), decomposed, so a combining mark is a separate
    # character to drop rather than composed into its letter. Both sides of
    # every comparison are folded the same way.
    decomposed = unicodedata.normalize("NFKD", text)
    kept = "".join(ch for ch in decomposed if unicodedata.category(ch) not in ("Cf", "Mn", "Me"))
    return " ".join(kept.casefold().split())


def quotes_held_share(rationale: str) -> bool:
    """The rationale holds `QUOTE_WINDOW` consecutive characters of the text of
    a share this agent still holds (or all of a shorter one of at least
    `MIN_QUOTE`), case and spacing folded. A share already sent or ended no
    longer has its text here, so it cannot be checked."""
    needle_space = _fold(rationale)
    try:
        entries = _load_map()
    except Exception:  # noqa: BLE001 - unreadable: treated as quoting (fail closed)
        return True
    for entry in entries.values():
        if entry.get("class") != SHARE_CLASS:
            continue
        obj = _parse(entry.get("payload"), SHARE_KEYS)
        if obj is None:
            continue
        text = _fold(obj["text"])
        if len(text) < QUOTE_WINDOW:
            if len(text) >= MIN_QUOTE and text in needle_space:
                return True
            continue
        if any(text[i:i + QUOTE_WINDOW] in needle_space for i in range(len(text) - QUOTE_WINDOW + 1)):
            return True
    return False


# ---- The map -----------------------------------------------------------------

_MAP_LOCK = threading.Lock()


def map_path() -> str:
    return os.path.join(hermes_home(), "av-events", MAP_FILE)


class _Locked:
    """The in-process lock plus `flock` on `share-vote.json.lock`."""

    def __enter__(self) -> "_Locked":
        _MAP_LOCK.acquire()
        self._fd: Optional[int] = None
        try:
            os.makedirs(os.path.dirname(map_path()), mode=DIR_MODE, exist_ok=True)
            self._fd = os.open(map_path() + ".lock", os.O_RDWR | os.O_CREAT, FILE_MODE)
            if fcntl is not None:
                fcntl.flock(self._fd, fcntl.LOCK_EX)
        except BaseException:
            self._release()
            raise
        return self

    def _release(self) -> None:
        try:
            if self._fd is not None:
                if fcntl is not None:
                    fcntl.flock(self._fd, fcntl.LOCK_UN)
                os.close(self._fd)
        finally:
            self._fd = None
            _MAP_LOCK.release()

    def __exit__(self, *exc: Any) -> None:
        self._release()


def _load_locked() -> dict[str, dict]:
    try:
        with open(map_path(), encoding="utf-8") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return {}
    data = json.loads(raw)
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, dict):
        raise ValueError("share-vote map unreadable")
    return {k: v for k, v in entries.items() if isinstance(k, str) and _ENTRY_ID.fullmatch(k) and isinstance(v, dict)}


def _save_locked(entries: dict[str, dict]) -> None:
    path = map_path()
    fd, tmp = tempfile.mkstemp(prefix=".share-vote.", dir=os.path.dirname(path))
    try:
        os.fchmod(fd, FILE_MODE)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"v": 1, "entries": entries}, handle, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load_map() -> dict[str, dict]:
    with _Locked():
        return _load_locked()


def lookup(entry_id: str) -> Optional[dict]:
    try:
        return _load_map().get(entry_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: share_vote map_read_failed=%s", type(exc).__name__)
        return None


def _evict(entries: dict[str, dict]) -> None:
    now = float(_clock())

    def keep(entry: dict) -> bool:
        if entry.get("state") in LIVE:
            return True
        # A shared digest stays revocable until it lapses.
        expires = epoch_from_iso(entry.get("expires_at")) if entry.get("state") == "emitted" else None
        return expires is not None and expires > now

    while len(entries) > MAX_MAP_ENTRIES:
        victim = next((k for k, v in entries.items() if not keep(v)), None)
        entries.pop(victim if victim is not None else next(iter(entries)))


def _cas(entry_id: str, expect: Optional[frozenset[str]], change: Callable[[dict], None], *,
         claim: Optional[str] = None) -> Optional[dict]:
    """Under the map lock: when the entry's state is in `expect` (any when
    None) and, with `claim`, it still carries that claim, apply `change` and
    save. A copy of the entry after, else None."""
    try:
        with _Locked():
            entries = _load_locked()
            entry = entries.get(entry_id)
            if entry is None or (expect is not None and entry.get("state") not in expect):
                return None
            if claim is not None and entry.get("claim") != claim:
                return None
            change(entry)
            entry["updated_at"] = float(_clock())
            if entry.get("state") not in ("starting", "emitting"):
                entry.pop("claim", None)
                entry.pop("claimed_at", None)
                entry.pop("back", None)
            if entry.get("state") in FINAL:
                entry.pop("payload", None)
                entry.pop("rationale", None)
                entry.pop("inline_until", None)
            _save_locked(entries)
            return json.loads(json.dumps(entry))
    except Exception as exc:  # noqa: BLE001 - a map that cannot be written moves nothing
        logger.warning("av-events: share_vote map_write_failed=%s", type(exc).__name__)
        return None


def _set(entry_id: str, expect, state: str, *, claim: Optional[str] = None, **fields: Any) -> Optional[dict]:
    def change(entry: dict) -> None:
        entry["state"] = state
        for name, value in fields.items():
            if value is None:
                entry.pop(name, None)
            else:
                entry[name] = value

    return _cas(entry_id, None if expect is None else frozenset(expect), change, claim=claim)


def _note(entry_id: str, code: str) -> None:
    def change(entry: dict) -> None:
        entry["code"] = code

    _cas(entry_id, LIVE, change)


def _open(entry_id: str, entry: dict, *, inline: bool = True, cap_pending: bool = False) -> Optional[str]:
    """Write a new entry (state `unfiled`). None, or a code."""
    try:
        with _Locked():
            entries = _load_locked()
            if entry_id in entries:
                return "entry_exists"
            if cap_pending:
                pending = sum(1 for v in entries.values() if v.get("class") == SHARE_CLASS and v.get("state") in LIVE)
                if pending >= MAX_PENDING_SHARES:
                    return "too_many_pending"
            now = float(_clock())
            entry = dict(entry, state="unfiled", opened_at=now, updated_at=now)
            if inline:
                entry["inline_until"] = now + INLINE_GRACE_S
            entries[entry_id] = entry
            _evict(entries)
            _save_locked(entries)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: share_vote map_write_failed=%s", type(exc).__name__)
        return "map_unwritable"


def _end_inline(entry_id: str) -> None:
    def change(entry: dict) -> None:
        entry.pop("inline_until", None)

    _cas(entry_id, None, change)


# ---- Shape and bounds ----------------------------------------------------------


def valid_shape(entry_id: str, entry: dict, *, payload: bool = True) -> bool:
    """The map is the agent's to write (same uid): nothing it names is
    trusted. The class is one of the two, the key is exactly the canonical
    key for the entry's own fields (a vote's with this process's tenant), and
    the held bytes are exactly the proposed object for those fields."""
    cls = entry.get("class")
    if cls == SHARE_CLASS:
        digest_id = entry.get("digest_id")
        if not isinstance(digest_id, str) or not DIGEST_ID.fullmatch(digest_id) or digest_id in RESERVED_IDS:
            return False
        if entry.get("key") != share_key(digest_id) or entry_id != entry.get("key"):
            return False
        if not payload:
            return True
        obj = _parse(entry.get("payload"), SHARE_KEYS)
        return (obj is not None and obj["digest_id"] == digest_id and obj["scope"] == entry.get("scope")
                and obj["expires_at"] == entry.get("expires_at") and SCOPE.fullmatch(obj["scope"]) is not None)
    if cls == VOTE_CLASS:
        tenant = tenant_id()
        question_id, answer = entry.get("question_id"), entry.get("answer")
        if tenant is None or not isinstance(question_id, str) or not vq.QUESTION_ID.fullmatch(question_id):
            return False
        if not isinstance(answer, str) or not vq.OPTION_KEY.fullmatch(answer):
            return False
        if entry.get("key") != vote_key(question_id, tenant) or entry_id != entry.get("key"):
            return False
        return not payload or entry.get("payload") == vote_payload(question_id, answer)
    return False


def _vote_question(entry: dict, now: float) -> tuple[Optional["vq.Question"], Optional[tuple[str, str]]]:
    """(the provider's open question, None) when this vote may still be
    proposed or started, else (None, (final state, code)). The provider is the
    only authority on the question: its id, its options and its close; the
    map's copy of any of them is never read."""
    try:
        question = vq.current_question()
    except vq.QuestionUnavailable:
        return None, ("closed", "question_unavailable")
    if question.question_id != entry.get("question_id"):
        return None, ("closed", "question_unavailable")
    if entry.get("answer") not in question.keys:
        return None, ("invalid", "answer_not_an_option")
    if now >= float(question.closes_at) - CLOSE_MARGIN_S:
        return None, ("closed", "question_closed")
    return question, None


def _bounds(entry: dict, now: float) -> Optional[tuple[str, str]]:
    """(final state, code) when this proposal can no longer be acted on now."""
    if entry.get("class") != SHARE_CLASS:
        return _vote_question(entry, now)[1]
    held = _parse(entry.get("payload"), SHARE_KEYS)
    expires = epoch_from_iso(held["expires_at"] if held is not None else entry.get("expires_at"))
    if expires is None:
        return "invalid", "expires_invalid"
    if expires - now < MIN_REMAINING_S:
        return "lapsed", "share_expired"
    if expires - now > DIGEST_MAX_TTL_S:
        return "refused", "expires_too_far"
    return None


def _content_problem(entry: dict) -> Optional[str]:
    """What the door would refuse in the bytes themselves, and what the
    sanitiser would change on the way out (the event would no longer hash to
    its own `payload_hash`)."""
    payload = entry.get("payload")
    if entry.get("class") == SHARE_CLASS:
        obj = _parse(payload, SHARE_KEYS)
        if obj is None:
            return "payload_invalid"
        problem = digest_text_problem(obj["text"])
        if problem is not None:
            return problem
    elif _parse(payload, VOTE_KEYS) is None:
        return "payload_invalid"
    return "text_sanitized" if sanitize(payload) != payload else None


def _withdraw_task(entry: dict, reason: str) -> None:
    task = entry.get("task")
    if not isinstance(task, str) or entry.get("state") != "requested":
        return
    try:
        _approval.withdraw(task, reason)
    except _approval.ApprovalUnavailable as exc:
        logger.info("av-events: share_vote withdraw_unsent=%s", exc.code)
    except Exception as exc:  # noqa: BLE001
        logger.info("av-events: share_vote withdraw_unsent=%s", type(exc).__name__)


def _end_out_of_bounds(entry_id: str, entry: dict, state: str, code: str, expect) -> "Outcome":
    """A proposal past its share's expiry or its question's close: ended, and
    a pending question withdrawn on the daemon (best effort)."""
    if _set(entry_id, expect, state, code=code) is not None:
        _withdraw_task(entry, "the share expired" if entry.get("class") == SHARE_CLASS else "the question closed")
    return Outcome(state, code=code, task=entry.get("task"))


# ---- Advancing one proposal ------------------------------------------------------


class Outcome:
    __slots__ = ("state", "code", "task", "authorization", "start_seq")

    def __init__(self, state: str, *, code: Optional[str] = None, task: Optional[str] = None,
                 authorization: Optional[str] = None, start_seq: Optional[int] = None) -> None:
        self.state = state
        self.code = code
        self.task = task
        self.authorization = authorization
        self.start_seq = start_seq


def _invalid(entry_id: str, expect) -> Outcome:
    _set(entry_id, expect, "invalid", code="map_invalid")
    logger.warning("av-events: share_vote map_invalid")
    return Outcome("invalid", code="map_invalid")


def _granted(task: Any) -> tuple[bool, Optional["_approval.Answer"], Optional[str]]:
    if not isinstance(task, str):
        return False, None, "task_missing"
    try:
        answer = _approval.wait(task)
    except _approval.ApprovalUnavailable as exc:
        return False, None, exc.code
    return answer.exit_code == 0 and answer.status == "granted", answer, None


def _cleared(entry: dict, question: Optional["vq.Question"]) -> tuple[bool, Optional[str]]:
    """The same `propose` again (idempotent): the policy still clears this
    vote, nothing executed it, and core's hash is the held bytes'."""
    summary = summary_for(entry, question)
    if utf8_len(summary) > SUMMARY_MAX_BYTES or utf8_len(entry["key"]) > MAX_KEY_BYTES:
        return False, "summary_too_long"
    try:
        answer = _approval.propose(entry["class"], entry["key"], summary, entry["payload"])
    except _approval.ApprovalUnavailable as exc:
        return False, exc.code
    except (UnicodeError, ValueError, TypeError):
        return False, "payload_unencodable"
    if not answer.ok:
        return False, answer.error_code or f"exit_{answer.exit_code}"
    doc = answer.doc
    if doc.get("action_key") != entry["key"] or doc.get("class") != entry["class"]:
        return False, "bad_answer"
    if doc.get("payload_hash") != entry.get("payload_hash") or sha256_hex(entry.get("payload")) != entry.get("payload_hash"):
        return False, "payload_hash_mismatch"
    if doc.get("decision") not in ("autonomous", "supervised") or doc.get("state") is not None:
        return False, "not_cleared"
    return True, None


def _propose(entry_id: str, entry: dict) -> Optional[Outcome]:
    if not valid_shape(entry_id, entry):
        return _invalid(entry_id, {"unfiled"})
    if utf8_len(entry["key"]) > MAX_KEY_BYTES:
        _set(entry_id, {"unfiled"}, "invalid", code="key_too_long")
        return Outcome("invalid", code="key_too_long")
    problem = _content_problem(entry)
    if problem is not None:
        # Bytes the door would refuse never reach the resident's prompt.
        _set(entry_id, {"unfiled"}, "invalid", code=problem)
        return Outcome("invalid", code=problem)
    now = float(_clock())
    question = None
    if entry.get("class") == VOTE_CLASS:
        question, out = _vote_question(entry, now)
    else:
        out = _bounds(entry, now)
    if out is not None:
        return _end_out_of_bounds(entry_id, entry, out[0], out[1], {"unfiled"})
    payload = entry["payload"]
    summary = summary_for(entry, question)
    if utf8_len(summary) > SUMMARY_MAX_BYTES:  # the exact string sent, encoded
        _set(entry_id, {"unfiled"}, "invalid", code="summary_too_long")
        return Outcome("invalid", code="summary_too_long")
    try:
        answer = _approval.propose(entry["class"], entry["key"], summary, payload)
    except _approval.ApprovalUnavailable as exc:
        _note(entry_id, exc.code)
        return Outcome("unfiled", code=exc.code)
    except (UnicodeError, ValueError, TypeError):
        # Nothing was sent, and the same bytes never could be.
        _set(entry_id, {"unfiled"}, "invalid", code="payload_unencodable")
        return Outcome("invalid", code="payload_unencodable")
    if not answer.ok:
        code = answer.error_code or f"exit_{answer.exit_code}"
        if code in REFUSED_CODES:
            _set(entry_id, {"unfiled"}, "refused", code=code)
            logger.info("av-events: share_vote proposal_refused=%s", code)
            return Outcome("refused", code=code)
        _note(entry_id, code)
        return Outcome("unfiled", code=code)
    doc = answer.doc
    task = doc.get("task") if isinstance(doc.get("task"), str) else None
    if task is None or not task.startswith("propose:"):
        _note(entry_id, "bad_answer")
        return Outcome("unfiled", code="bad_answer")
    if doc.get("action_key") != entry["key"] or doc.get("class") != entry["class"]:
        _note(entry_id, "bad_answer")
        return Outcome("unfiled", code="bad_answer")
    registered = doc.get("payload_hash")
    if not isinstance(registered, str) or registered != sha256_hex(payload):
        _set(entry_id, {"unfiled"}, "refused", code="payload_hash_mismatch", task=task)
        logger.warning("av-events: share_vote payload_hash_mismatch")
        return Outcome("refused", code="payload_hash_mismatch", task=task)
    decision, state = doc.get("decision"), doc.get("state")
    if state == "executed":
        new, stop = "start_unconfirmed", True
    elif decision == "requested":
        if state in ("requested", "granted"):
            new, stop = "requested", state == "requested"
        else:
            new, stop = "rejected", True
    elif decision in ("autonomous", "supervised") and state is None:
        new, stop = "cleared", False
    else:
        _note(entry_id, "bad_answer")
        return Outcome("unfiled", code="bad_answer")
    _set(entry_id, {"unfiled"}, new, task=task, payload_hash=registered, code=None)
    return Outcome(new, task=task) if stop else None


def _repropose_void(entry_id: str, expect: set[str], claim: Optional[str] = None) -> Optional[Outcome]:
    """A grant or request pinned to a superseded policy: the same bytes are
    proposed again (a new question under the new policy), at most ten times."""
    def change(entry: dict) -> None:
        count = int(entry.get("reproposals_void") or 0)
        if count >= MAX_VOID_REPROPOSALS:
            entry["state"] = "expired"
            entry["code"] = "void"
            return
        entry["reproposals_void"] = count + 1
        entry["state"] = "unfiled"
        entry["code"] = "void"

    after = _cas(entry_id, frozenset(expect), change, claim=claim)
    if after is not None and after.get("state") == "expired":
        return Outcome("expired", code="void")
    return None


def _poll(entry_id: str, entry: dict, execute: bool) -> Optional[Outcome]:
    task = entry.get("task")
    if not isinstance(task, str):
        _set(entry_id, {"requested"}, "unfiled")
        return None
    out = _bounds(entry, float(_clock()))
    if out is not None:
        return _end_out_of_bounds(entry_id, entry, out[0], out[1], {"requested"})
    granted, answer, code = _granted(task)
    if answer is None:
        _note(entry_id, code or "transport")
        return Outcome("requested", code=code, task=task)
    if granted:
        if not execute:
            return Outcome("requested", code="deferred", task=task)
        return _execute(entry_id, entry, "grant")
    exit_code, status = answer.exit_code, answer.status
    if exit_code == 6:
        return Outcome("requested", task=task)
    if exit_code == 0:
        if status in ("executed", "nothing-to-wait-for"):
            _set(entry_id, {"requested"}, "start_unconfirmed", code=status)
            return Outcome("start_unconfirmed", code=status, task=task)
        _note(entry_id, f"wait_status_{status}")
        return Outcome("requested", code="not_granted", task=task)
    if exit_code == 1 and answer.error_code == "not-registered":
        _set(entry_id, {"requested"}, "unfiled", code="not-registered")
        return None
    if exit_code == 1 and status in ("rejected", "revoked", "withdrawn"):
        final = "withdrawn" if status == "withdrawn" else "rejected"
        _set(entry_id, {"requested"}, final, code=status)
        return Outcome(final, code=status, task=task)
    if exit_code == 3 and status == "expired":
        # The resident did not answer in the window: no event, and the
        # resident is not asked again.
        _set(entry_id, {"requested"}, "expired", code="expired")
        return Outcome("expired", code="expired", task=task)
    if exit_code == 7 and status == "void":
        return _repropose_void(entry_id, {"requested"})
    _note(entry_id, f"wait_exit_{exit_code}")
    return Outcome("requested", code="not_granted", task=task)


def _release(entry_id: str, claim: str, back: str, code: str) -> Outcome:
    _set(entry_id, {"starting"}, back, claim=claim, code=code)
    return Outcome(back, code=code)


def _event_type(entry: dict) -> str:
    return SHARED_EVENT if entry.get("class") == SHARE_CLASS else VOTE_EVENT


def _ready() -> bool:
    try:
        return _emit_fn is not None and (_ready_fn is None or bool(_ready_fn()))
    except Exception:  # noqa: BLE001
        return False


def _execute(entry_id: str, entry: dict, kind: str) -> Optional[Outcome]:
    """Claim, re-read the authority, start, emit. `kind` is `grant` (just read
    granted) or `policy` (a vote the policy clears, inside its tool call)."""
    back = "requested" if kind == "grant" else "cleared"
    expected = "grant" if kind == "grant" else "policy"
    if kind == "policy" and entry.get("class") != VOTE_CLASS:
        # A share admits only a human grant (§5: no grant, no write).
        _set(entry_id, {back}, "not_shared", code="share_needs_grant")
        return Outcome("not_shared", code="share_needs_grant")
    if not valid_shape(entry_id, entry):
        return _invalid(entry_id, {back})
    payload = entry.get("payload")
    if sha256_hex(payload) is None or sha256_hex(payload) != entry.get("payload_hash"):
        _set(entry_id, {back}, "unfiled", code="payload_hash_mismatch")
        return None
    now = float(_clock())
    question = None
    if entry.get("class") == VOTE_CLASS:
        # Before the claim: the provider, never the map, says which question
        # is open, which answers it takes and when it closes.
        question, out = _vote_question(entry, now)
    else:
        out = _bounds(entry, now)
    if out is not None:
        return _end_out_of_bounds(entry_id, entry, out[0], out[1], {back})
    problem = _content_problem(entry)
    if problem is not None:
        _set(entry_id, {back}, "refused", code=problem)
        _withdraw_task(entry, "the proposal can no longer be sent")
        return Outcome("refused", code=problem)
    if not _ready():
        # Nothing could carry the event: the grant waits (until it lapses).
        _note(entry_id, "emitter_inactive")
        return Outcome(back, code="emitter_inactive", task=entry.get("task"))
    claim = uuid7()

    def take(e: dict) -> None:
        e["state"] = "starting"
        e["claim"] = claim
        e["back"] = back
        e["claimed_at"] = now
        e.pop("code", None)

    if _cas(entry_id, frozenset({back}), take) is None:
        return Outcome("starting")
    task = entry.get("task")
    if kind == "grant":
        ok, answer, why = _granted(task)
        if not ok:
            if answer is not None and answer.exit_code == 7 and answer.status == "void":
                return _repropose_void(entry_id, {"starting"}, claim=claim)
            return _release(entry_id, claim, back, why or f"wait_exit_{answer.exit_code if answer else 'none'}")
    else:
        ok, why = _cleared(entry, question)
        if not ok:
            # Ask from the start: the class may be manual now, or executed.
            _set(entry_id, {"starting"}, "unfiled", claim=claim, code=why or "not_cleared")
            return None
    try:
        answer = _approval.start(task, entry["key"], payload)
    except _approval.ApprovalUnavailable as exc:
        # Whether it landed is unknown: the next read of the daemon tells (a
        # spent grant reads nothing-to-wait-for and is never emitted).
        return _release(entry_id, claim, back, exc.code)
    except (UnicodeError, ValueError, TypeError):
        # Nothing was sent, and the same bytes never could be.
        _set(entry_id, {"starting"}, "invalid", claim=claim, code="payload_unencodable")
        return Outcome("invalid", code="payload_unencodable")
    if not answer.ok:
        error = answer.error_code or f"exit_{answer.exit_code}"
        if error == "already-executed":
            _set(entry_id, {"starting"}, "start_unconfirmed", claim=claim, code=error)
            return Outcome("start_unconfirmed", code=error)
        if error == "policy-drift":
            return _repropose_void(entry_id, {"starting"}, claim=claim)
        if error == "expired":
            _set(entry_id, {"starting"}, "expired", claim=claim, code=error)
            return Outcome("expired", code=error)
        if error in REFUSED_CODES:
            _set(entry_id, {"starting"}, "refused", claim=claim, code=error)
            return Outcome("refused", code=error)
        return _release(entry_id, claim, back, error)
    doc = answer.doc
    authorization = doc.get("authorization")
    seq = doc.get("seq")
    if authorization != expected:
        _set(entry_id, {"starting"}, "refused", claim=claim, code="authorization_mismatch")
        logger.warning("av-events: share_vote authorization_mismatch")
        return Outcome("refused", code="authorization_mismatch")
    if doc.get("action_key") != entry["key"] or doc.get("class") != entry["class"] or doc.get("task", task) != task:
        # A start recorded for some other action than the one this call read.
        _set(entry_id, {"starting"}, "refused", claim=claim, code="start_answer_mismatch")
        logger.warning("av-events: share_vote start_answer_mismatch")
        return Outcome("refused", code="start_answer_mismatch")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
        # Recorded, but the event could not name its start: never sent.
        _set(entry_id, {"starting"}, "start_unconfirmed", claim=claim, code="start_seq_missing")
        return Outcome("start_unconfirmed", code="start_seq_missing")
    return _emit_granted(entry_id, entry, claim, payload, authorization, seq)


def _event_body(cls: str, granted: str, granted_hash: str, seq: int, authorization: str) -> Optional[dict]:
    """The event payload from the granted bytes themselves (never from the
    entry's other fields), with the hash of those same bytes."""
    if cls == SHARE_CLASS:
        return shared_event_payload(granted, granted_hash, seq, authorization) if authorization == "grant" else None
    tenant = tenant_id()
    if tenant is None or authorization not in ("grant", "policy"):
        return None
    return vote_event_payload(granted, tenant, granted_hash, seq, authorization)


def _emit_granted(entry_id: str, entry: dict, claim: str, granted: str, authorization: str, seq: int) -> Outcome:
    """Emit the event for the start this call holds, and nothing else.

    `granted` is the string this call sent to `start`, which answered ok, so
    core checked that those bytes hash to the binding the resident was asked
    about. The event is built from that string (one parse of it, its own
    SHA-256 as `payload_hash`), never from the map. The map is read twice
    more, only to refuse: when the held bytes, the hash core answered at
    `propose`, the key or the claim are not still exactly this call's, the
    event is not sent (`payload_tampered`)."""
    cls, key = entry["class"], entry["key"]
    granted_hash = sha256_hex(granted)
    body = _event_body(cls, granted, granted_hash, seq, authorization) if granted_hash is not None else None
    if (body is None or granted_hash != entry.get("payload_hash") or body.get("idempotency_key") != sha256_hex(key)
            or sanitize(body) != body):
        _set(entry_id, {"starting"}, "emit_refused", claim=claim, code="event_invalid")
        logger.warning("av-events: share_vote emit_refused=event_invalid")
        return Outcome("emit_refused", code="event_invalid")
    now = float(_clock())
    if cls == SHARE_CLASS:
        expires = epoch_from_iso(body["expires_at"])
        if expires is None or expires - now < MIN_REMAINING_S or expires - now > DIGEST_MAX_TTL_S:
            # The door would refuse it; the start is spent on it.
            _set(entry_id, {"starting"}, "lapsed", claim=claim, code="emit_lapsed")
            return Outcome("lapsed", code="emit_lapsed")
    event_id = derived_uuid7(int(now * 1000), f"av-events|{_event_type(entry)}|{key}|{seq}")

    def still_granted(e: dict) -> bool:
        return (e.get("key") == key and e.get("class") == cls and sha256_hex(e.get("payload")) == granted_hash
                and e.get("payload_hash") == granted_hash)

    def to_emitting(e: dict) -> None:
        if not still_granted(e):
            e["state"] = "emit_refused"
            e["code"] = "payload_tampered"
            return
        e["state"] = "emitting"
        e.update(authorization=authorization, start_seq=seq, event_id=event_id, emitting_at=now)

    after = _cas(entry_id, frozenset({"starting"}), to_emitting, claim=claim)
    if after is None:
        return Outcome("starting")  # the claim is not ours any more: nothing sent
    if after.get("state") != "emitting":
        logger.warning("av-events: share_vote emit_refused=payload_tampered")
        return Outcome("emit_refused", code="payload_tampered")
    held = lookup(entry_id)
    if held is None or held.get("state") != "emitting" or held.get("claim") != claim or not still_granted(held):
        _set(entry_id, {"emitting"}, "emit_refused", claim=claim, code="payload_tampered")
        logger.warning("av-events: share_vote emit_refused=payload_tampered")
        return Outcome("emit_refused", code="payload_tampered")
    if not _send(_event_type(entry), body, event_id, now):
        # The start is spent and nothing carried the event: never sent later
        # on the strength of the map.
        _set(entry_id, {"emitting"}, "emit_failed", claim=claim, code="emit_failed")
        return Outcome("emit_failed", code="emit_failed", authorization=authorization, start_seq=seq)
    _set(entry_id, {"emitting"}, "emitted", claim=claim, code=None)
    return Outcome("emitted", authorization=authorization, start_seq=seq)


def _send(event_type: str, body: dict, event_id: str, at: float) -> bool:
    fn = _emit_fn
    if fn is None:
        return False
    try:
        return bool(fn(event_type, body, event_id=event_id, occurred_at=iso_from_epoch(at)))
    except Exception as exc:  # noqa: BLE001 - not buffered: the caller ends the entry
        logger.warning("av-events: share_vote emit_failed=%s", type(exc).__name__)
        return False


def _stale(entry_id: str, entry: dict) -> Optional[Outcome]:
    at = entry.get("claimed_at")
    if isinstance(at, (int, float)) and float(_clock()) - float(at) <= STALE_STARTING_S:
        return Outcome("starting")
    back = entry.get("back") if entry.get("back") in ("requested", "cleared") else "requested"
    # Abandoned before the event was fixed: ask the daemon again from there (a
    # start that landed reads nothing-to-wait-for and is never emitted).
    _set(entry_id, {"starting"}, back, claim=entry.get("claim"), code="claim_abandoned")
    return None


def _stale_emitting(entry_id: str, entry: dict) -> Outcome:
    """`emitting` is only ever advanced by the call that holds its start. One
    the pass meets is that call in flight (left alone) or a call that died:
    never sent from here, whatever the map says."""
    at = entry.get("emitting_at")
    if isinstance(at, (int, float)) and not isinstance(at, bool) and float(_clock()) - float(at) <= STALE_EMITTING_S:
        return Outcome("emitting")
    _set(entry_id, {"emitting"}, "emit_unconfirmed", claim=entry.get("claim"), code="emit_unconfirmed")
    return Outcome("emit_unconfirmed", code="emit_unconfirmed")


def advance(entry_id: str, *, execute: bool = True, inline: bool = False, expect_class: Optional[str] = None) -> Outcome:
    """Take the proposal as far as the daemon's answers allow now. Never raises.

    `inline`: the tool call itself is advancing (the poller is kept off it
    meanwhile). `expect_class`: only a vote's own tool call, with the class in
    memory, executes a start the policy clears. `execute`: False for a
    one-shot resume pass outside the gateway, which stops before `start`. An
    event is emitted only inside `_execute`, by the call whose `start` the
    daemon just answered ok."""
    try:
        for _ in range(MAX_STEPS):
            entry = lookup(entry_id)
            if entry is None:
                return Outcome("none")
            state = entry.get("state")
            until = entry.get("inline_until")
            if not inline and isinstance(until, (int, float)) and until > float(_clock()):
                return Outcome(state or "unknown")
            if state not in LIVE:
                return Outcome(state or "unknown", code=entry.get("code"), task=entry.get("task"),
                               authorization=entry.get("authorization"), start_seq=entry.get("start_seq"))
            if state == "unfiled":
                result = _propose(entry_id, entry)
            elif state == "requested":
                result = _poll(entry_id, entry, execute)
            elif state == "cleared":
                if entry.get("class") == SHARE_CLASS:
                    _set(entry_id, {"cleared"}, "not_shared", code="share_needs_grant")
                    result = Outcome("not_shared", code="share_needs_grant")
                elif inline and execute and expect_class == VOTE_CLASS and entry.get("class") == VOTE_CLASS:
                    result = _execute(entry_id, entry, "policy")
                else:
                    _set(entry_id, {"cleared"}, "not_cast", code="rule_needs_call")
                    result = Outcome("not_cast", code="rule_needs_call")
            elif state == "starting":
                result = _stale(entry_id, entry)
            else:
                return _stale_emitting(entry_id, entry)
            if result is not None:
                return result
        return Outcome("unknown")
    except Exception as exc:  # noqa: BLE001 - never into Hermes, never kills the poller
        logger.warning("av-events: share_vote advance_failed=%s", type(exc).__name__)
        return Outcome("error", code="internal")


# ---- The pass and the poller -------------------------------------------------------


def _switched_on(entry: dict) -> bool:
    cls = entry.get("class")
    return (cls == SHARE_CLASS and share_on()) or (cls == VOTE_CLASS and vote_on())


def run_share_vote_pass(execute: bool = True) -> None:
    """Advance every live share and vote once (at most `MAX_PER_PASS`), each
    only while its own switch is on. `execute` False: stop before `start`."""
    if not active():
        return
    try:
        entries = _load_map()
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: share_vote map_read_failed=%s", type(exc).__name__)
        return
    now = float(_clock())
    todo = []
    for entry_id, entry in entries.items():
        if entry.get("state") not in LIVE or not _switched_on(entry):
            continue
        until = entry.get("inline_until")
        if isinstance(until, (int, float)) and until > now:
            continue
        todo.append(entry_id)
    counts: dict[str, int] = {}
    for entry_id in todo[:MAX_PER_PASS]:
        outcome = advance(entry_id, execute=execute)
        counts[outcome.state] = counts.get(outcome.state, 0) + 1
    if counts:
        logger.info("av-events: share_vote pass %s", " ".join(f"{k}={v}" for k, v in sorted(counts.items())))


PASS_NAME = "share_vote"


def maybe_start(platform: Any = None, argv: Optional[list] = None) -> str:
    """Register this pass on Lane B's poller and start it the way Lane B does
    (`_intent_approval.maybe_start`): the thread in the gateway, a one-shot
    pass that stops before `start` elsewhere, nothing at a registration
    outside the gateway. `thread`, `pass`, `idle` or `off`."""
    if not active():
        return "off"
    from . import _intent_approval as ia

    _approval.register_pass(PASS_NAME, run_share_vote_pass)
    mode = _approval.process_env(_approval.POLLER_ENV).lower()
    name = str(platform or "").strip().lower()
    gateway = (mode in _approval.TRUTHY or ia._gateway_argv(argv)
               or (platform is not None and name not in ia.LOCAL_PLATFORMS))
    if mode in ("0", "false", "no", "off"):
        gateway = False
    if gateway:
        _approval.ensure_poller()
        _approval.kick()
        return "thread"
    if platform is None:
        return "idle"
    _approval.kick()
    return "pass"


def _on_session_start(*_args: Any, **kwargs: Any) -> None:
    try:
        maybe_start(kwargs.get("platform"))
    except Exception:  # noqa: BLE001 - a listener never reaches Hermes
        pass


# ---- The tools ---------------------------------------------------------------------

_NOT_APPROVAL = "A yes you read in chat is not an approval. Do not share or vote another way."

REFUSALS: dict[str, str] = {
    "disabled": "This is switched off for this agent; nothing was proposed.",
    "approval_not_configured": (
        "Nothing was proposed: the resident's approval channel is not set up for this agent, and this "
        "needs the resident's approval. " + _NOT_APPROVAL
    ),
    "action_invalid": "Unknown action. Nothing was changed.",
    "text_required": "Nothing was proposed: text is required, the digest exactly as the resident should see it.",
    "text_too_long": "Nothing was proposed: a digest is at most 500 characters. Shorten it and ask again.",
    "text_invalid": (
        "Nothing was proposed: the text holds a character that cannot be shared (a control, a direction "
        "override, an invisible or private-use character). Write it again as plain text."
    ),
    "text_no_letter_or_digit": "Nothing was proposed: a digest needs at least one letter or digit.",
    "text_sanitized": (
        "Nothing was proposed: the text contains something shaped like a credential or token. Leave it out."
    ),
    "scope_invalid": "Nothing was proposed: scope is village, or service:<name> in lower case.",
    "too_many_pending": (
        "Nothing was proposed: five digests are already waiting for the resident. Wait for their answers, "
        "or revoke one, before proposing another."
    ),
    "digest_id_required": "Nothing was changed: this action needs the digest_id a share returned.",
    "digest_unknown": "Nothing was changed: this agent holds no digest with that digest_id.",
    "share_in_flight": "Not revoked yet: this digest is being shared right now. Try again in a minute.",
    "revoke_failed": "Not revoked yet: the revocation could not be recorded just now. Try again in a minute.",
    "not_available_no_events": (
        "Nothing was proposed: this agent's village event connection is not set up, so an approved share or "
        "vote would go nowhere. Tell the resident it is not available yet."
    ),
    "not_available_no_consent": (
        "Nothing was proposed: the resident is not in the Agent Village research, and shares and votes reach "
        "the village only for residents who are. They can change that on the Research participation panel "
        "on the Agent Village landing page."
    ),
    "rationale_invisible": (
        "Nothing was proposed: the rationale holds an invisible or direction-changing character. Write it as "
        "plain text."
    ),
    "rationale_mixed_script": (
        "Nothing was proposed: the rationale mixes Latin letters with look-alike letters from another script. "
        "Write it in one script."
    ),
    "rationale_charset": (
        "Nothing was proposed: write the rationale as plain words: letters, digits, spaces and . , ; ! ? ' \" ( ) -, "
        "with no colon, link, address, mention, tag or symbol."
    ),
    "rationale_imitates_prompt": (
        "Nothing was proposed: the rationale repeats the wording of the approval prompt itself. Say why in "
        "your own words."
    ),
    "rationale_quotes_share": (
        "Nothing was proposed: the rationale repeats a digest the resident has not approved sharing. "
        "Leave it out."
    ),
    "expires_invalid": "Nothing was proposed: expires_in_hours is a whole number from 1 to 167, in digits 0-9.",
    "tenant_unknown": (
        "Nothing was proposed: this agent does not know its own tenant id, which the vote is keyed on. "
        "Tell the resident the vote could not be filed."
    ),
    "question_unavailable": (
        "There is no weekly village question this agent can read yet. Do not answer one another way."
    ),
    "question_id_required": "Nothing was proposed: question_id is required (the id action=question returned).",
    "question_not_open": "Nothing was proposed: that is not the open weekly question. Read it with action=question.",
    "question_closed": "Nothing was proposed: the weekly question has closed.",
    "answer_invalid": "Nothing was proposed: answer must be one of the question's option keys, exactly.",
    "rationale_invalid": (
        "Nothing was proposed: the rationale is one short line (at most 280 characters) of plain text "
        "with no credential-like strings."
    ),
    "vote_already_proposed": (
        "Nothing was proposed: an answer to this question has already been proposed to the resident, "
        "and a question takes one answer. Its status is below."
    ),
    "vote_unknown": "Nothing was changed: no answer to that question has been proposed by this agent.",
    "vote_in_flight": "Not withdrawn: this vote is being cast right now.",
    "vote_already_cast": "Not withdrawn: this vote has already been cast, and a cast vote cannot be taken back.",
    "map_unwritable": "Nothing was proposed: this agent could not record it locally. Try again later.",
    "internal": "This could not run just now; nothing was proposed. " + _NOT_APPROVAL,
}

#: What each final or live state means, for the agent.
STATE_MESSAGES: dict[str, str] = {
    "unfiled": "The approval service could not be reached; the request will be filed when it can. " + _NOT_APPROVAL,
    "requested": "The resident has been asked in their approval channel. " + _NOT_APPROVAL,
    "cleared": "The resident's policy clears this; it is being done.",
    "starting": "It is being done now.",
    "emitting": "The resident approved it; it is being handed over now.",
    "emitted": (
        "The resident approved it, and it was handed to this agent's event queue for the village. "
        "Delivery is not confirmed from here."
    ),
    "revoked": (
        "Revoked: the revocation was handed to this agent's event queue for the village. Delivery is not "
        "confirmed from here."
    ),
    "rejected": "The resident declined it. It was not done; do not try another way.",
    "withdrawn": "Withdrawn; nothing was shared or cast.",
    "expired": "The resident did not answer in time. Nothing was done.",
    "refused": (
        "The approval service refused the request (the resident's policy may not allow it). Nothing was done."
    ),
    "start_unconfirmed": "The approval could not be confirmed, so nothing was sent.",
    "lapsed": "The digest expired before it could be shared. Nothing was shared.",
    "closed": "The question closed before the vote could be cast. Nothing was cast.",
    "not_shared": (
        "Not shared: a digest is shared only on the resident's own approval, and their policy did not ask them."
    ),
    "not_cast": "Not cast: the resident's policy could not be confirmed in this call. Nothing was cast.",
    "invalid": "This request could not be checked, so nothing was done.",
    "emit_refused": (
        "The approval was recorded, but what would have been sent was not exactly what the resident approved, "
        "so nothing was shared or cast."
    ),
    "emit_failed": "The approval was recorded but the result could not be sent. Nothing was shared or cast.",
    "emit_unconfirmed": "It could not be confirmed that this was sent, so it is not sent again.",
    "revoke_lapsed": "The digest had already expired, so there was nothing left to revoke.",
    "error": "This could not run just now. " + _NOT_APPROVAL,
}


def _refuse(code: str, **extra: Any) -> dict:
    return {"success": False, "error": code, "message": REFUSALS[code], **extra}


def _state_answer(outcome: Outcome, **fields: Any) -> dict:
    state = outcome.state
    result: dict[str, Any] = {"success": True, **fields, "state": state,
                              "message": STATE_MESSAGES.get(state, STATE_MESSAGES["error"])}
    if outcome.code:
        result["code"] = outcome.code
    return result


SHARE_DESCRIPTION = (
    "Share a short digest with village services, only with the resident's approval. A digest is a short "
    "text the resident chooses to make available, such as what they are looking for this week; draft it "
    "with them or suggest one, and show them the exact words first. action=share (text, scope, optional "
    "expires_in_hours up to 167) asks the resident in their approval channel and returns a digest_id; it "
    "is shared only when they approve it there, never on a yes you read in chat. action=revoke (digest_id), "
    "when the resident asks, stops sharing it (or withdraws the request if they have not answered). "
    "action=status (digest_id) says where it stands."
)

VOTE_DESCRIPTION = (
    "The weekly village question. action=question reads the open question, its option keys and when it "
    "closes. action=vote (question_id, answer as one option key, optional one-line rationale) asks the "
    "resident in their approval channel to confirm the answer you believe they would give; the vote is "
    "cast only when they approve it there, never on a yes you read in chat. A question takes one answer "
    "from this agent. action=withdraw (question_id) withdraws an answer the resident has not approved yet; "
    "action=status (question_id) says where it stands."
)

SHARE_SCHEMA: dict = {
    "name": SHARE_TOOL,
    "description": SHARE_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["share", "revoke", "status"]},
            "text": {"type": "string", "description": "The digest, exactly as the resident approves it (at most 500 characters)."},
            "scope": {"type": "string", "description": "village (default), or service:<name> for one village service."},
            "expires_in_hours": {"type": "integer", "minimum": 1, "maximum": 167,
                                 "description": "How long it stays shared; default and most 167 (7 days)."},
            "digest_id": {"type": "string", "description": "The id a share returned. Required for revoke and status."},
        },
        "additionalProperties": False,
    },
}

VOTE_SCHEMA: dict = {
    "name": VOTE_TOOL,
    "description": VOTE_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["question", "vote", "withdraw", "status"]},
            "question_id": {"type": "string", "description": "The open question's id, from action=question."},
            "answer": {"type": "string", "description": "One of the question's option keys, exactly."},
            "rationale": {"type": "string",
                          "description": "Optional: one line on why you believe this is the resident's answer. Shown to them."},
        },
        "additionalProperties": False,
    },
}


def _action(args: dict, default: str) -> str:
    value = args.get("action")
    return value.strip().lower() if isinstance(value, str) and value.strip() else default


_ASCII_HOURS = re.compile(r"[0-9]{1,3}")


def _ttl_hours(value: Any) -> Optional[float]:
    """An ASCII integer from 1 to 167 (an int, or a string of ASCII digits);
    anything else, other scripts' digits included, is refused."""
    if value is None:
        return DEFAULT_TTL_S
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        if not _ASCII_HOURS.fullmatch(value.strip()):
            return None
        value = int(value.strip())
    if not isinstance(value, int) or not 1 <= value <= 167:
        return None
    return min(float(value) * 3600.0, float(MAX_TTL_S))


def _research_consent() -> Optional[bool]:
    """Whether events from this tenant reach the research database: True,
    False (no research consent, or no choice on record: the worker drops
    them), or None when it cannot be told (`consent_status`'s own read)."""
    try:
        from . import _consent
        from ._core import env

        status = _consent.fetch_consent_status(env("AV_EVENTS_URL"), env("AV_EVENTS_TOKEN"))
    except Exception:  # noqa: BLE001
        return None
    if isinstance(status, _consent.ConsentUnavailable):
        return None
    if status is None:
        return False
    return status.get("research") is True


def _delivery_problem() -> Optional[str]:
    """Why an approved share or vote would go nowhere, so the resident is not
    asked: nothing can carry the event (no token, the plugin off, or a null
    sink that never sends), or ingest says this tenant is not in the research
    (the worker drops these events then). None when it would be delivered or
    that cannot be told."""
    if not _ready():
        return "not_available_no_events"
    if _research_consent() is False:
        return "not_available_no_consent"
    return None


def _share(args: dict) -> dict:
    text = args.get("text")
    problem = digest_text_problem(text)
    if problem is not None:
        return _refuse(problem)
    if sanitize(text) != text:
        return _refuse("text_sanitized")
    scope = args.get("scope")
    scope = "village" if scope is None or (isinstance(scope, str) and not scope.strip()) else scope
    if not isinstance(scope, str) or not SCOPE.fullmatch(scope.strip()):
        return _refuse("scope_invalid")
    scope = scope.strip()
    ttl = _ttl_hours(args.get("expires_in_hours"))
    if ttl is None:
        return _refuse("expires_invalid")
    problem = _delivery_problem()
    if problem is not None:
        return _refuse(problem)
    digest_id = str(uuid.uuid4())
    expires_at = iso_from_epoch(float(_clock()) + max(float(MIN_TTL_S), ttl))
    entry = {"class": SHARE_CLASS, "key": share_key(digest_id), "digest_id": digest_id, "scope": scope,
             "expires_at": expires_at, "payload": share_payload(digest_id, scope, text, expires_at)}
    code = _open(entry["key"], entry, cap_pending=True)
    if code is not None:
        return _refuse("too_many_pending" if code == "too_many_pending" else "map_unwritable")
    try:
        outcome = advance(entry["key"], inline=True)
    finally:
        _end_inline(entry["key"])
    return _state_answer(outcome, digest_id=digest_id, scope=scope, expires_at=expires_at)


def _digest_entry(args: dict) -> tuple[Optional[str], Optional[dict], Optional[dict]]:
    digest_id = args.get("digest_id")
    if not isinstance(digest_id, str) or not digest_id.strip():
        return None, None, _refuse("digest_id_required")
    digest_id = digest_id.strip().lower()
    if not DIGEST_ID.fullmatch(digest_id):
        return None, None, _refuse("digest_unknown")
    entry = lookup(share_key(digest_id))
    if entry is None or entry.get("class") != SHARE_CLASS:
        return None, None, _refuse("digest_unknown")
    return digest_id, entry, None


#: Digest ids this process has sent a revocation for: at most one each.
_REVOKED_IDS: set[str] = set()
_REVOKE_LOCK = threading.Lock()


def _revoke(args: dict) -> dict:
    digest_id, entry, refusal = _digest_entry(args)
    if refusal is not None:
        return refusal
    entry_id = share_key(digest_id)
    state = entry.get("state")
    if state in ("starting", "emitting"):
        return _refuse("share_in_flight", digest_id=digest_id)
    if state in ("unfiled", "requested", "cleared", "refused"):
        after = _set(entry_id, {"unfiled", "requested", "cleared", "refused"}, "withdrawn", code="resident_revoked")
        if after is None:
            return _refuse("share_in_flight", digest_id=digest_id)
        _withdraw_task(entry, "the resident revoked the digest")
        return _state_answer(Outcome("withdrawn", code="resident_revoked"), digest_id=digest_id, shared=False)
    if state == "emitted":
        now = float(_clock())
        expires = epoch_from_iso(entry.get("expires_at"))
        if expires is not None and expires <= now:
            return _state_answer(Outcome("revoke_lapsed", code="share_lapsed"), digest_id=digest_id)
        seq = entry.get("start_seq")
        if (not isinstance(entry.get("event_id"), str) or isinstance(seq, bool) or not isinstance(seq, int)
                or entry.get("authorization") != "grant"):
            # Not a share this module sent (it writes these with the event).
            return _refuse("digest_unknown")
        with _REVOKE_LOCK:
            if digest_id in _REVOKED_IDS:
                return _state_answer(Outcome("revoked"), digest_id=digest_id, shared=False)
            # Claimed first (one revocation per share), then sent; put back
            # when nothing carried it, so the resident's next request tries again.
            if _set(entry_id, {"emitted"}, "revoked", revoked_at=now) is None:
                return _refuse("revoke_failed", digest_id=digest_id)
            _REVOKED_IDS.add(digest_id)
        event_id = derived_uuid7(int(now * 1000), f"av-events|{REVOKED_EVENT}|{digest_id}")
        if not _send(REVOKED_EVENT, revoked_event_payload(digest_id), event_id, now):
            _set(entry_id, {"revoked"}, "emitted", revoked_at=None, code="revoke_failed")
            with _REVOKE_LOCK:
                _REVOKED_IDS.discard(digest_id)
            return _refuse("revoke_failed", digest_id=digest_id)
        return _state_answer(Outcome("revoked"), digest_id=digest_id, shared=False)
    # Final without a share (declined, expired, withdrawn...) or already revoked.
    return _state_answer(Outcome(state or "unknown", code=entry.get("code")), digest_id=digest_id, shared=False)


def _share_status(args: dict) -> dict:
    digest_id, entry, refusal = _digest_entry(args)
    if refusal is not None:
        return refusal
    outcome = advance(share_key(digest_id), execute=False) if entry.get("state") in ("unfiled", "requested") else None
    entry = lookup(share_key(digest_id)) or entry
    state = outcome.state if outcome is not None and outcome.state != "error" else entry.get("state", "unknown")
    return _state_answer(Outcome(state, code=entry.get("code")), digest_id=digest_id,
                         scope=entry.get("scope"), expires_at=entry.get("expires_at"))


def share_digest_answer(args: Any) -> dict:
    args = args if isinstance(args, dict) else {}
    if not share_on():
        return _refuse("disabled")
    if not _approval.configured():
        return _refuse("approval_not_configured")
    action = _action(args, "share")
    if action == "share":
        return _share(args)
    if action == "revoke":
        return _revoke(args)
    if action == "status":
        return _share_status(args)
    return _refuse("action_invalid")


def _question_answer() -> dict:
    try:
        q = vq.current_question()
    except vq.QuestionUnavailable as exc:
        return _refuse("question_unavailable", reason=exc.code)
    return {"success": True, "question_id": q.question_id, "text": q.text,
            "options": [{"key": o.key, "label": o.label} for o in q.options], "closes_at": iso_from_epoch(q.closes_at)}


def _vote(args: dict) -> dict:
    tenant = tenant_id()
    if tenant is None:
        return _refuse("tenant_unknown")
    question_id = args.get("question_id")
    if not isinstance(question_id, str) or not question_id.strip():
        return _refuse("question_id_required")
    question_id = question_id.strip()
    try:
        q = vq.current_question()
    except vq.QuestionUnavailable as exc:
        return _refuse("question_unavailable", reason=exc.code)
    if question_id != q.question_id:
        return _refuse("question_not_open")
    if float(_clock()) >= float(q.closes_at) - CLOSE_MARGIN_S:
        return _refuse("question_closed")
    answer = args.get("answer")
    if not isinstance(answer, str) or answer.strip() not in q.keys:
        return _refuse("answer_invalid")
    answer = answer.strip()
    rationale, code = clean_rationale(args.get("rationale"))
    if code is not None:
        return _refuse(code)
    if rationale and quotes_held_share(rationale):
        return _refuse("rationale_quotes_share")
    problem = _delivery_problem()
    if problem is not None:
        return _refuse(problem)
    key = vote_key(question_id, tenant)
    existing = lookup(key)
    if existing is not None:
        if existing.get("answer") != answer:
            return _refuse("vote_already_proposed", question_id=question_id, answer=existing.get("answer"),
                           state=existing.get("state"))
        if existing.get("state") == "refused":
            # Filed again with the same bytes, in case the policy changed.
            def reopen(e: dict) -> None:
                e["state"] = "unfiled"
                e["payload"] = vote_payload(question_id, answer)
                e["inline_until"] = float(_clock()) + INLINE_GRACE_S
                if rationale:
                    e["rationale"] = rationale
                e.pop("code", None)

            if _cas(key, frozenset({"refused"}), reopen) is None:
                return _refuse("internal")
        else:
            return _state_answer(advance(key, execute=False) if existing.get("state") in ("unfiled", "requested")
                                 else Outcome(existing.get("state", "unknown"), code=existing.get("code")),
                                 question_id=question_id, answer=answer)
    else:
        entry = {"class": VOTE_CLASS, "key": key, "question_id": question_id, "answer": answer,
                 "payload": vote_payload(question_id, answer)}
        if rationale:
            entry["rationale"] = rationale
        code = _open(key, entry)
        if code is not None:
            return _refuse("map_unwritable" if code == "map_unwritable" else "internal")
    try:
        outcome = advance(key, inline=True, expect_class=VOTE_CLASS)
    finally:
        _end_inline(key)
    return _state_answer(outcome, question_id=question_id, answer=answer)


def _vote_entry(args: dict) -> tuple[Optional[str], Optional[dict], Optional[dict]]:
    tenant = tenant_id()
    if tenant is None:
        return None, None, _refuse("tenant_unknown")
    question_id = args.get("question_id")
    if not isinstance(question_id, str) or not vq.QUESTION_ID.fullmatch(question_id.strip()):
        return None, None, _refuse("question_id_required")
    key = vote_key(question_id.strip(), tenant)
    entry = lookup(key)
    if entry is None:
        return None, None, _refuse("vote_unknown")
    return key, entry, None


def _vote_withdraw(args: dict) -> dict:
    key, entry, refusal = _vote_entry(args)
    if refusal is not None:
        return refusal
    state = entry.get("state")
    if state in ("starting", "emitting"):
        return _refuse("vote_in_flight")
    if state == "emitted":
        return _refuse("vote_already_cast")
    if state in ("unfiled", "requested", "cleared", "refused"):
        if _set(key, {"unfiled", "requested", "cleared", "refused"}, "withdrawn", code="agent_withdrew") is None:
            return _refuse("vote_in_flight")
        _withdraw_task(entry, "the agent withdrew the answer")
        state = "withdrawn"
    return _state_answer(Outcome(state or "unknown"), question_id=entry.get("question_id"))


def _vote_status(args: dict) -> dict:
    key, entry, refusal = _vote_entry(args)
    if refusal is not None:
        return refusal
    if entry.get("state") in ("unfiled", "requested"):
        advance(key, execute=False)
        entry = lookup(key) or entry
    return _state_answer(Outcome(entry.get("state", "unknown"), code=entry.get("code")),
                         question_id=entry.get("question_id"), answer=entry.get("answer"))


def village_vote_answer(args: Any) -> dict:
    args = args if isinstance(args, dict) else {}
    if not vote_on():
        return _refuse("disabled")
    if not _approval.configured():
        return _refuse("approval_not_configured")
    action = _action(args, "question")
    if action == "question":
        return _question_answer()
    if action == "vote":
        return _vote(args)
    if action == "withdraw":
        return _vote_withdraw(args)
    if action == "status":
        return _vote_status(args)
    return _refuse("action_invalid")


def _handler(name: str, answer: Callable[[Any], dict]) -> Callable[..., str]:
    def tool(args: Any = None, **_kwargs: Any) -> str:
        action = "-"
        try:
            if isinstance(args, dict) and isinstance(args.get("action"), str):
                action = args["action"].strip().lower()[:16] or "-"
            result = answer(args)
        except SystemExit:
            raise
        except BaseException as exc:  # noqa: BLE001 - fail closed, never into Hermes
            try:
                logger.warning("av-events: %s failed=%s", name, type(exc).__name__)
            except Exception:  # noqa: BLE001
                pass
            return json.dumps(_refuse("internal"))
        try:
            # Codes only: never the text, the rationale or an answer key.
            logger.info("av-events: %s action=%s state=%s code=%s", name,
                        action if re.fullmatch(r"[a-z_-]{1,16}", action) else "other",
                        result.get("state") or "-", result.get("error") or result.get("code") or "-")
        except Exception:  # noqa: BLE001
            pass
        return json.dumps(result, ensure_ascii=False)

    tool.__name__ = name
    return tool


def register_share_vote_tools(ctx: Any, emit: Optional[Callable[..., bool]] = None,
                              ready: Optional[Callable[[], bool]] = None) -> list[str]:
    """Register `share_digest` and `village_vote`, each only when its switch is
    on, and this pass on the approval poller. The names registered."""
    wanted = [(SHARE_TOOL, SHARE_SCHEMA, share_digest_answer, SHARE_DESCRIPTION, share_on()),
              (VOTE_TOOL, VOTE_SCHEMA, village_vote_answer, VOTE_DESCRIPTION, vote_on())]
    if not any(on for *_rest, on in wanted):
        return []
    if not _approval.configured():
        # Neither tool exists without the resident's approval channel.
        logger.info("av-events: share_vote skipped=approval_not_configured")
        return []
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        logger.info("av-events: share_vote skipped=no_register_tool")
        return []
    set_emitter(emit, ready)
    registered: list[str] = []
    for name, schema, answer, description, on in wanted:
        if not on:
            continue
        handler = _handler(name, answer)
        try:
            try:
                register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler, description=description)
            except TypeError:
                register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler)
            registered.append(name)
        except Exception as exc:  # noqa: BLE001
            logger.warning("av-events: %s register_failed=%s", name, type(exc).__name__)
    if registered:
        register_hook = getattr(ctx, "register_hook", None)
        try:
            if callable(register_hook):
                register_hook("on_session_start", _on_session_start)
            maybe_start(None)
        except Exception as exc:  # noqa: BLE001 - pending proposals wait for the next session start
            logger.warning("av-events: share_vote approval_wiring_failed=%s", type(exc).__name__)
        logger.info("av-events: share_vote registered=%s", ",".join(registered))
    return registered


__all__ = [
    "CLASSES",
    "LIVE",
    "Outcome",
    "REVOKED_EVENT",
    "SHARED_EVENT",
    "SHARE_CLASS",
    "SHARE_SWITCH",
    "SHARE_TOOL",
    "VOTE_CLASS",
    "VOTE_EVENT",
    "VOTE_SWITCH",
    "VOTE_TOOL",
    "advance",
    "canonical",
    "digest_text_problem",
    "maybe_start",
    "register_share_vote_tools",
    "revoked_event_payload",
    "run_share_vote_pass",
    "set_emitter",
    "share_digest_answer",
    "share_key",
    "share_payload",
    "shared_event_payload",
    "summary_for",
    "village_vote_answer",
    "vote_event_payload",
    "vote_key",
    "vote_payload",
]
