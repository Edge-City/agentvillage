"""The weekly village question, as the `village_vote` tool reads it (lane O3).

DATA-99 AC #3 publishes each week's question to the operational datastore
(`ods.questions`: an id, the question's text, its options, opens-at and
closes-at), and each resident's agent reads it there. That store does not
exist yet: the ODS service and its read path are not built (DATA-96 §8), and
no other source is defined for the question (no control-plane route, no
variable, no file the installer writes, no event). So this module does not
invent one. It is the single seam the vote path reads the question through:

- `current_question()` returns the open `Question` (its id, its text, its
  options as option keys with the labels the source gives them, and when it
  closes), or raises `QuestionUnavailable(code)`;
- the implementation shipped here is `_not_yet_available`, which always
  raises `question_source_not_built`, so the tool refuses every vote with
  that coded reason until a real provider replaces it;
- `set_provider(fn)` replaces it (the tests use a fake; the ODS read path
  will be the real one).

The provider is the only trusted source of a question: the vote path asks it
again before it proposes a vote and again before it starts one, and the
resident's prompt shows the question's text and the option's label from it,
never from anything the agent wrote.

Python 3.11, standard library only.
"""

from __future__ import annotations

import re
from typing import Callable, Optional

#: `vote.cast@1`'s `question_id`: the envelope id rule without `:`, so the
#: key `village.vote:<question_id>:<tenant>` has one parse.
QUESTION_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
#: `vote.cast@1`'s `answer`: an option key, never free text.
OPTION_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
MAX_OPTIONS = 32
MAX_QUESTION_TEXT = 2000
MAX_LABEL = 200


class QuestionUnavailable(Exception):
    """No open question can be read now. `code` says why."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Option:
    """One answer: its key (what `vote.cast` carries) and the label the
    source gives it (what the resident reads), which may be absent."""

    __slots__ = ("key", "label")

    def __init__(self, key: str, label: Optional[str] = None) -> None:
        self.key = key
        self.label = label


class Question:
    """One open weekly question: what the agent may answer, and until when."""

    __slots__ = ("question_id", "text", "options", "opens_at", "closes_at")

    def __init__(self, question_id: str, text: Optional[str], options: tuple[Option, ...], closes_at: float,
                 opens_at: Optional[float] = None) -> None:
        self.question_id = question_id
        self.text = text
        self.options = options
        self.opens_at = opens_at
        self.closes_at = closes_at

    @property
    def keys(self) -> tuple[str, ...]:
        return tuple(o.key for o in self.options)

    def option(self, key: str) -> Optional[Option]:
        return next((o for o in self.options if o.key == key), None)


def valid(question: object) -> bool:
    """A question the vote path can use: shaped id, 1..32 options with shaped
    keys and no repeats (a label a bounded string or absent), a bounded text
    or none, and a close time."""
    if not isinstance(question, Question):
        return False
    if not isinstance(question.question_id, str) or not QUESTION_ID.fullmatch(question.question_id):
        return False
    if question.text is not None and (not isinstance(question.text, str) or len(question.text) > MAX_QUESTION_TEXT):
        return False
    options = question.options
    if not isinstance(options, tuple) or not 1 <= len(options) <= MAX_OPTIONS:
        return False
    if not all(isinstance(o, Option) and isinstance(o.key, str) and OPTION_KEY.fullmatch(o.key) for o in options):
        return False
    if len({o.key for o in options}) != len(options):
        return False
    if not all(o.label is None or (isinstance(o.label, str) and len(o.label) <= MAX_LABEL) for o in options):
        return False
    if isinstance(question.closes_at, bool) or not isinstance(question.closes_at, (int, float)):
        return False
    return question.opens_at is None or (isinstance(question.opens_at, (int, float))
                                         and not isinstance(question.opens_at, bool))


def _not_yet_available() -> Question:
    """NOT YET AVAILABLE. The contract's source is `ods.questions`, which is
    not built; until it is, there is no question to answer."""
    raise QuestionUnavailable("question_source_not_built")


_provider: Callable[[], Question] = _not_yet_available


def set_provider(fn: Optional[Callable[[], Question]]) -> None:
    """Replace the provider (None restores the not-yet-available one)."""
    global _provider
    _provider = fn if fn is not None else _not_yet_available


def current_question() -> Question:
    """The open question, or `QuestionUnavailable`. Never anything else."""
    try:
        question = _provider()
    except QuestionUnavailable:
        raise
    except Exception:  # noqa: BLE001 - a provider that fails is no question
        raise QuestionUnavailable("question_unreadable") from None
    if not valid(question):
        raise QuestionUnavailable("question_invalid")
    return question


__all__ = [
    "OPTION_KEY",
    "Option",
    "QUESTION_ID",
    "Question",
    "QuestionUnavailable",
    "current_question",
    "set_provider",
    "valid",
]
