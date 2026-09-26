"""`consent_status`: the agent's answer to "am I in the research?" (DATA-157).

Nothing in a sandbox knew the resident's consent, so the agent answered "not
recorded". Ingest now serves `GET {AV_EVENTS_URL}/v1/consent` to this
sandbox's own plugin token (`agentvillage-data` `src/ingest/consent.ts`, whose
module comment is the contract), and this module is its client and the words
the agent answers with.

It is a **read**. It never writes a file, never emits an event and never sends
anything but the one GET. Consent is changed only on the Research
participation panel on the Agent Village landing page (spec §5.3); every
answer says so.

Three results, never confused:

- a dict with the contract's eight keys: the tenant's village consent;
- `None`: ingest answered JSON `null`, no village choice is on record;
- a `ConsentUnavailable`: anything else (no token, no URL, a non-200, a
  network error, a timeout, a redirect, a malformed body). The agent says it
  could not check. It is **never** read as "not in the research".

The pure half (`parse_consent_body`, `consent_sentence`) is separate from the
network half (`fetch_consent_status`) and the Hermes half (`consent_status_tool`)
so each is tested alone. Log lines carry codes only: never the URL, the token
or anything from the row.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional, Union

from ._core import NO_REDIRECT_OPENER, env, env_flag_disabled, is_redirect, register_literal_secret

logger = logging.getLogger("av-events")

#: The tool as the model sees it.
TOOL_NAME = "consent_status"

#: Hermes groups plugin tools by toolset; a plugin toolset is offered to the
#: model on every platform unless the operator turned it off
#: (`hermes_cli/tools_config.py` `_enabled_plugin_toolsets`).
TOOLSET = "av-events"

CONSENT_PATH = "/v1/consent"

#: Seconds for each blocking socket operation (connect, each read). urllib
#: applies it per operation, so on its own it bounds nothing: a server that
#: drips a byte every few seconds would hold the turn indefinitely, and DNS
#: resolution ignores it altogether.
CONSENT_TIMEOUT_S = 5.0

#: Seconds for the whole fetch — DNS, connect, headers and body together. The
#: model is waiting on this inside a turn, and "I could not check" is a fine
#: answer after a few seconds.
CONSENT_DEADLINE_S = 8.0

#: `brief_version` as ingest's own payload schema allows it. Anything else is
#: not a brief version, and it is text the model would read.
BRIEF_VERSION = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

#: A consent body is a few hundred bytes. Anything past this is not one.
MAX_BODY_BYTES = 64 * 1024

#: The switch that silences this tool alone, in `AV_HOOKS_DISABLED` like the
#: other two non-hook names (`memory_recalled`, `cron_run`).
KILL_SWITCH_NAME = "consent_status"

STATES = ("granted", "declined", "withdrawn")

#: The contract's keys (`ConsentStatus` in `src/ingest/consent.ts`).
CONSENT_KEYS = (
    "state",
    "research",
    "training",
    "brief_version",
    "accepted_at",
    "withdrawn_at",
    "popup_id",
    "withdrawal_pending_until",
)

_STRING_KEYS = ("brief_version", "accepted_at", "withdrawn_at", "popup_id", "withdrawal_pending_until")
_DATE_KEYS = ("accepted_at", "withdrawn_at", "withdrawal_pending_until")

PANEL = "the Research participation panel on the Agent Village landing page"

#: Said with every "not in the research": training never outlives research.
NO_TRAINING = "and your data is not used for training"

SENTENCE_NONE = (
    "No research choice is on record for this agent. To take part or decline, use "
    f"{PANEL}."
)
SENTENCE_UNAVAILABLE = (
    "I could not check your research status right now. The Research participation panel "
    "on the landing page shows it."
)

TOOL_DESCRIPTION = (
    "Check whether the person you work for is in the Agent Village research, and whether "
    "their data may be used for training, from the research consent record. Call this "
    "whenever they ask whether they are in the research or the training data, or about "
    "their research consent; answer only from what it returns and never guess. Takes no "
    "arguments: call it with an empty object. Read-only: consent is changed only on the "
    "Research participation panel on the Agent Village landing page, never in chat."
)

TOOL_SCHEMA: dict = {
    "name": TOOL_NAME,
    "description": TOOL_DESCRIPTION,
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}


class ConsentUnavailable:
    """"Could not check", with a code saying why (`no_token`, `http_503`, ...).

    Falsy is deliberately *not* defined: callers test `isinstance`, so an
    unavailable answer can never slip through an `if status:` as "none".
    """

    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def __repr__(self) -> str:
        return f"ConsentUnavailable({self.reason!r})"


ConsentResult = Union[dict, None, ConsentUnavailable]


# --------------------------------------------------------------------------
# Parsing (pure)
# --------------------------------------------------------------------------


def _utc(value: str) -> Optional[datetime]:
    """An ISO 8601 instant with a zone, in UTC, or None."""
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return None
        # A zoned instant at the edge of the calendar (`0001-01-01T00:00+01:00`)
        # parses, then overflows on the way to UTC.
        return stamp.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def parse_consent_body(body: Any) -> ConsentResult:
    """A decoded 200 body as the tool reads it.

    JSON `null` is `None`. A dict is accepted only when every contract key is
    present with its type, every date parses with a zone, and the row agrees
    with itself (`research` exactly when `granted`; `training` only with
    `research`; `withdrawal_pending_until` null while `research`; a
    `withdrawn_at` in `withdrawn`), and `brief_version` has ingest's own
    shape. It comes
    back holding exactly the contract's keys. Anything else is
    `ConsentUnavailable("malformed")`: a body this client cannot read must
    never become an answer about the person's consent.
    """
    if body is None:
        return None
    if not isinstance(body, dict):
        return ConsentUnavailable("malformed")
    if any(key not in body for key in CONSENT_KEYS):
        return ConsentUnavailable("malformed")
    state = body["state"]
    research = body["research"]
    training = body["training"]
    if state not in STATES or not isinstance(research, bool) or not isinstance(training, bool):
        return ConsentUnavailable("malformed")
    for key in _STRING_KEYS:
        if body[key] is not None and not isinstance(body[key], str):
            return ConsentUnavailable("malformed")
    for key in _DATE_KEYS:
        if body[key] is not None and _utc(body[key]) is None:
            return ConsentUnavailable("malformed")
    if body["brief_version"] is not None and not BRIEF_VERSION.fullmatch(body["brief_version"]):
        return ConsentUnavailable("malformed")
    if state == "withdrawn" and body["withdrawn_at"] is None:
        # The contract: `withdrawn` is the latest row's withdrawal, so it has a time.
        return ConsentUnavailable("malformed")
    if research != (state == "granted") or (training and not research):
        return ConsentUnavailable("malformed")
    if research and (body["withdrawal_pending_until"] is not None or body["withdrawn_at"] is not None):
        return ConsentUnavailable("malformed")
    return {key: body[key] for key in CONSENT_KEYS}


# --------------------------------------------------------------------------
# The words (pure)
# --------------------------------------------------------------------------


def _day(value: Optional[str]) -> Optional[str]:
    """`YYYY-MM-DD` in UTC, or None."""
    if not isinstance(value, str):
        return None
    stamp = _utc(value)
    return stamp.strftime("%Y-%m-%d") if stamp is not None else None


def _deletion(pending: Optional[str]) -> str:
    return f"Your data is deleted on {pending} unless you opt back in from {PANEL}."


def consent_sentence(status: ConsentResult) -> str:
    """What the agent tells the person, for each shape the contract allows.

    Never "you are in the research" unless `research` is true. Dates are UTC
    days. A shape this function does not recognise is "could not check".
    """
    if isinstance(status, ConsentUnavailable):
        return SENTENCE_UNAVAILABLE
    if status is None:
        return SENTENCE_NONE
    if not isinstance(status, dict):
        return SENTENCE_UNAVAILABLE

    state = status.get("state")
    research = status.get("research") is True
    accepted = _day(status.get("accepted_at"))
    withdrawn = _day(status.get("withdrawn_at"))
    pending = _day(status.get("withdrawal_pending_until"))
    brief = status.get("brief_version") if isinstance(status.get("brief_version"), str) else None

    if state == "granted" and research:
        opted = "You are in the research"
        if accepted and brief:
            opted += f": you opted in on {accepted} under research brief {brief}."
        elif accepted:
            opted += f": you opted in on {accepted}."
        elif brief:
            opted += f", under research brief {brief}."
        else:
            opted += "."
        training = (
            "You also agreed to your data being used for training."
            if status.get("training") is True
            else "You did not agree to your data being used for training."
        )
        return f"{opted} {training} To change this, use {PANEL}."

    if research:
        # `research` true outside `granted` contradicts the contract.
        return SENTENCE_UNAVAILABLE

    if state == "declined":
        head = (
            f"You are not in the research: you declined on {accepted}, {NO_TRAINING}."
            if accepted
            else f"You are not in the research: you declined, {NO_TRAINING}."
        )
        parts = [head]
        if pending:
            parts.append(_deletion(pending))
        parts.append(f"To take part, use {PANEL}.")
        return " ".join(parts)

    if state == "withdrawn":
        withdrawn_at = _utc(status["withdrawn_at"]) if isinstance(status.get("withdrawn_at"), str) else None
        accepted_at = _utc(status["accepted_at"]) if isinstance(status.get("accepted_at"), str) else None
        if withdrawn_at is not None and accepted_at is not None and withdrawn_at < accepted_at:
            # A re-grant the withdrawal's margin closed (DATA-151): the landing
            # may show opted in, the withdrawal still executes.
            head = (
                f"Your opt-in at {accepted} came too close to your withdrawal at {withdrawn} to count, "
                f"so you are not in the research, {NO_TRAINING}."
            )
            if pending:
                return (
                    f"{head} Your data is deleted on {pending} unless you opt back in: "
                    "turn the Research participation panel off and on again."
                )
            return f"{head} To opt back in, turn the Research participation panel off and on again."
        head = (
            f"You are not in the research: you withdrew on {withdrawn}, {NO_TRAINING}."
            if withdrawn
            else f"You are not in the research: you withdrew, {NO_TRAINING}."
        )
        if pending:
            return f"{head} {_deletion(pending)}"
        # Null means no deletion request is open: it has run, or none was made.
        return (
            f"{head} No deletion of your research data is pending: it has already been carried "
            f"out, or none was scheduled. To opt back in, use {PANEL}."
        )

    return SENTENCE_UNAVAILABLE


# --------------------------------------------------------------------------
# The GET
# --------------------------------------------------------------------------


def fetch_consent_status(
    url: str,
    token: str,
    timeout: float = CONSENT_TIMEOUT_S,
    deadline: float = CONSENT_DEADLINE_S,
) -> ConsentResult:
    """`GET {url}/v1/consent` with the plugin token. Never raises.

    `url` is `AV_EVENTS_URL`; trailing slashes are stripped exactly as the
    events poster strips them. No query string and no body: the tenant is the
    token's. 200 with a readable body is the answer; everything else is
    `ConsentUnavailable` with a code (`no_token`, `no_url`, `http_<status>`,
    `redirect`, `timeout`, a network exception's class name, `too_large`,
    `malformed`).

    `timeout` bounds each socket operation; `deadline` bounds the whole fetch.
    The fetch runs on a daemon thread that this call waits on for at most
    `deadline` seconds. Past it the answer is `timeout` and the thread is
    abandoned: a socket stuck in DNS lingers until its per-operation timeout;
    one fed a slow drip lingers until the server stops sending, the body cap
    is reached, or the process ends. It holds nothing but itself.
    That is the fail-open trade: the turn is never held longer than the
    deadline.
    """
    if not isinstance(token, str) or not token.strip():
        return ConsentUnavailable("no_token")
    if not isinstance(url, str) or not url.strip():
        return ConsentUnavailable("no_url")
    box: list = []

    def run() -> None:
        try:
            box.append(_fetch_once(url, token, timeout))
        except BaseException as exc:  # noqa: BLE001 - reported below, never raised
            box.append(ConsentUnavailable(type(exc).__name__))

    worker = threading.Thread(target=run, name="av-events-consent", daemon=True)
    worker.start()
    worker.join(deadline)
    if worker.is_alive() or not box:
        return ConsentUnavailable("timeout")
    return box[0]


def _fetch_once(url: str, token: str, timeout: float) -> ConsentResult:
    """The GET itself, on the worker thread. Every socket operation is bounded
    by `timeout`; the whole of it only by the caller's deadline."""
    request = urllib.request.Request(
        url.strip().rstrip("/") + CONSENT_PATH,
        headers={"Accept": "application/json", "Authorization": f"Bearer {token.strip()}"},
        method="GET",
    )
    try:
        # Redirects are refused (`_core.NoRedirect`): urllib would carry the bearer to the new host.
        with NO_REDIRECT_OPENER.open(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 0) or 0)
            raw = response.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as exc:
        try:
            exc.read()
        except Exception:  # noqa: BLE001 - draining the body must never raise
            pass
        code = int(getattr(exc, "code", 0) or 0)
        return ConsentUnavailable("redirect" if is_redirect(code) else f"http_{code}")
    except TimeoutError:
        return ConsentUnavailable("timeout")
    except urllib.error.URLError as exc:
        if isinstance(getattr(exc, "reason", None), TimeoutError):
            return ConsentUnavailable("timeout")
        return ConsentUnavailable(type(exc).__name__)
    except Exception as exc:  # noqa: BLE001 - sockets, TLS, DNS, a bad URL
        return ConsentUnavailable(type(exc).__name__)
    if status != 200:
        return ConsentUnavailable(f"http_{status}")
    if len(raw) > MAX_BODY_BYTES:
        return ConsentUnavailable("too_large")
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return ConsentUnavailable("malformed")
    return parse_consent_body(body)


# --------------------------------------------------------------------------
# The Hermes tool
# --------------------------------------------------------------------------


def _disabled() -> bool:
    """The plugin's kill switch, or this tool's own name in `AV_HOOKS_DISABLED`."""
    if env_flag_disabled("AV_EVENTS_ENABLED"):
        return True
    names = {part.strip().lower() for part in env("AV_HOOKS_DISABLED").split(",") if part.strip()}
    return KILL_SWITCH_NAME in names


def consent_status_answer() -> str:
    """Read the config the way the collector does, fetch, and put it in words."""
    if _disabled():
        status: ConsentResult = ConsentUnavailable("disabled")
    else:
        token = env("AV_EVENTS_TOKEN")
        register_literal_secret(token)
        status = fetch_consent_status(env("AV_EVENTS_URL"), token, CONSENT_TIMEOUT_S, CONSENT_DEADLINE_S)
    if isinstance(status, ConsentUnavailable):
        logger.warning("av-events: consent_status unavailable=%s", status.reason)
    return consent_sentence(status)


def consent_status_tool(args: Any = None, **_kwargs: Any) -> str:
    """The handler Hermes calls: `handler(args, **kwargs)` (`tools/registry.py`
    `dispatch`). Takes no arguments, returns one plain string, and never
    raises into Hermes: any failure is the could-not-check sentence and one
    log line naming the exception's class.
    """
    try:
        return consent_status_answer()
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 - fail open, like every hook
        try:
            logger.warning("av-events: consent_status failed=%s", type(exc).__name__)
        except Exception:  # noqa: BLE001
            pass
        return SENTENCE_UNAVAILABLE


def register_consent_tool(ctx: Any) -> bool:
    """Register `consent_status` when this Hermes can take a plugin tool.

    A Hermes without `ctx.register_tool` gets one log line and no tool; the
    hooks are registered either way. True when the tool was registered.
    """
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        logger.info("av-events: consent_status skipped=no_register_tool")
        return False
    try:
        try:
            register_tool(
                name=TOOL_NAME,
                toolset=TOOLSET,
                schema=TOOL_SCHEMA,
                handler=consent_status_tool,
                description=TOOL_DESCRIPTION,
            )
        except TypeError:
            # An older `register_tool` without `description`.
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=consent_status_tool)
    except Exception as exc:  # noqa: BLE001 - a tool must never cost the hooks
        logger.warning("av-events: consent_status register_failed=%s", type(exc).__name__)
        return False
    return True


__all__ = [
    "CONSENT_KEYS",
    "CONSENT_DEADLINE_S",
    "CONSENT_PATH",
    "CONSENT_TIMEOUT_S",
    "ConsentUnavailable",
    "SENTENCE_NONE",
    "SENTENCE_UNAVAILABLE",
    "TOOLSET",
    "TOOL_NAME",
    "TOOL_SCHEMA",
    "consent_sentence",
    "consent_status_answer",
    "consent_status_tool",
    "fetch_consent_status",
    "parse_consent_body",
    "register_consent_tool",
]
