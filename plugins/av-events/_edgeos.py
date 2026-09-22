"""The EdgeOS action path: RSVP → `action.attempted`, confirming read → `action.receipted`.

Spec §4.1 `action.attempted/receipted/failed`, §2.1's receipt allowance
(`receipt.kind = edgeos_confirming_read`), and the measurement catalogue's
"Act on intentions (RSVP)" row.

The `edgeos` skill reaches EdgeOS by running `curl` through Hermes's `terminal`
tool (`skills/edgeos/SKILL.md` §6); there is no EdgeOS tool with its own name.
So an EdgeOS operation is recognised by parsing the one `curl` in a carrier
tool's command — its method and the path of its one URL — against the frozen
seed `edgeos_tool_allowlist.json`. Nothing of the command, the headers or the
response body leaves the sandbox: the only values that do are the operation
name, the EdgeOS event id and participant id (UUIDs, validated as such), an
occurrence timestamp, and the ids minted here.

**Positive evidence only.** An RSVP or cancellation waits for a confirming read
only when EdgeOS answered with the participant record (a JSON object carrying
its `id`). A gateway error page, an empty body, a `{"message": ...}` — none of
them is evidence the action landed, so none of them can later be "confirmed"
by a read that merely finds the participant registered some other way.

Everything here is pure except `Ledger.load` / `Ledger.save`.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import time
import urllib.parse
from collections import OrderedDict
from typing import Any, Callable, Optional

from ._core import DIR_MODE, FILE_MODE, iso_from_text
from ._intentions import _first_json, valid_id

SEED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "edgeos_tool_allowlist.json")

RECEIPT_KIND = "edgeos_confirming_read"
TARGET_SYSTEM = "edgeos"

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
UUID_RE = re.compile(rf"^{_UUID}$")
_PARAM = re.compile(r"\{([a-z_]+)\}")
_ROLES = frozenset({"action", "confirming_read", "read", "write"})
_METHODS = frozenset({"GET", "POST", "PATCH", "PUT", "DELETE"})

#: A command longer than this is not parsed: an RSVP is one short `curl`.
MAX_COMMAND_CHARS = 16 * 1024

#: `my_rsvp_status` values that confirm each action class. `None` (the key
#: present, the value null) confirms a cancellation only when the plugin saw
#: the RSVP it reverses — otherwise "not registered" may simply mean "never was".
CONFIRMS: dict[str, frozenset] = {
    "rsvp": frozenset({"registered", "checked_in"}),
    "cancel_rsvp": frozenset({"cancelled"}),
}

#: Pending actions and last-known actions kept, per map.
MAX_LEDGER_ENTRIES = 256
#: A pending action no read has confirmed within this long is dropped.
PENDING_TTL_S = 7 * 24 * 60 * 60


class Operation:
    __slots__ = ("operation", "method", "pattern", "role", "action_class", "reverses")

    def __init__(self, operation: str, method: str, pattern: "re.Pattern[str]", role: str,
                 action_class: Optional[str], reverses: Optional[str]) -> None:
        self.operation = operation
        self.method = method
        self.pattern = pattern
        self.role = role
        self.action_class = action_class
        self.reverses = reverses


class Allowlist:
    __slots__ = ("version", "hosts", "carriers", "operations")

    def __init__(self, version: Optional[str], hosts: frozenset, carriers: frozenset, operations: list) -> None:
        self.version = version
        self.hosts = hosts
        self.carriers = carriers
        self.operations = operations


def _compile_path(path: str) -> Optional["re.Pattern[str]"]:
    if not path.startswith("/"):
        return None
    out, last = [], 0
    for match in _PARAM.finditer(path):
        out.append(re.escape(path[last:match.start()]))
        out.append(f"(?P<{match.group(1)}>{_UUID})")
        last = match.end()
    out.append(re.escape(path[last:]))
    return re.compile("^" + "".join(out) + "/?$")


def load_allowlist(path: str = SEED_FILE) -> Allowlist:
    """The seed, or an empty allowlist that recognises nothing."""
    try:
        with open(path, encoding="utf-8") as handle:
            seed = json.load(handle)
    except (OSError, ValueError):
        seed = None
    if not isinstance(seed, dict):
        return Allowlist(None, frozenset(), frozenset(), [])
    hosts = frozenset(h.lower() for h in seed.get("hosts") or () if isinstance(h, str) and h)
    carriers = frozenset(t for t in seed.get("carrier_tools") or () if isinstance(t, str) and t)
    operations: list[Operation] = []
    for entry in seed.get("operations") or ():
        if not isinstance(entry, dict):
            continue
        name, method, route, role = (entry.get(k) for k in ("operation", "method", "path", "role"))
        if not (isinstance(name, str) and isinstance(method, str) and isinstance(route, str) and role in _ROLES):
            continue
        if method.upper() not in _METHODS:
            continue
        pattern = _compile_path(route)
        if pattern is None:
            continue
        action_class = entry.get("action_class") if role == "action" else None
        if role == "action" and action_class not in CONFIRMS:
            continue
        reverses = entry.get("reverses") if isinstance(entry.get("reverses"), str) else None
        operations.append(Operation(name, method.upper(), pattern, role, action_class, reverses))
    version = seed.get("version") if isinstance(seed.get("version"), str) else None
    return Allowlist(version, hosts, carriers, operations)


ALLOWLIST = load_allowlist()

# --------------------------------------------------------------------------
# Recognising a call
# --------------------------------------------------------------------------

#: Any http(s) URL's authority, anywhere in the command, quoted or not.
_ANY_URL = re.compile(r"https?://([^/\s'\"`?#<>|;&()\\]*)", re.IGNORECASE)

#: Characters the tokeniser splits out as shell control operators (newline
#: included). A run of them is one token, e.g. `&&` or `;\n`.
_PUNCTUATION = "();<>|&\n"


def _is_operator(token: str) -> bool:
    return bool(token) and all(c in _PUNCTUATION for c in token)


#: curl options that change where the request actually goes, or whether the
#: host is who it claims to be. A command using any of them is not read.
_REFUSED_SHORT = frozenset("xKk")
_REFUSED_LONG = frozenset({"--resolve", "--connect-to", "--proxy", "--config", "--insecure", "--socks5",
                           "--socks5-hostname", "--preproxy", "--doh-url"})

#: curl short options that take an argument (`curl --help all`). Everything
#: else in a cluster like `-sSfL` is a flag; `-sXPOST` and `-sX POST` both
#: end the cluster at `X` and take the rest, or the next word, as its value.
_SHORT_WITH_ARG = frozenset("XdHFowuAebcrTmxEKzYyCPQtUD")
_DATA_SHORT = frozenset("dF")
_DATA_LONG = frozenset({
    "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json",
    "--form", "--form-string",
})
_LONG_WITH_ARG = _DATA_LONG | frozenset({
    "--request", "--url", "--header", "--output", "--write-out", "--user", "--user-agent", "--referer",
    "--cookie", "--cookie-jar", "--range", "--max-time", "--connect-timeout", "--retry", "--retry-delay",
    "--retry-max-time", "--proxy", "--cert", "--key", "--cacert", "--config", "--upload-file",
    "--limit-rate", "--max-filesize", "--resolve", "--connect-to", "--interface", "--oauth2-bearer",
    "--variable", "--expand-url", "--expand-header", "--expand-data",
})


class HttpCall:
    __slots__ = ("method", "path", "query")

    def __init__(self, method: str, path: str, query: dict) -> None:
        self.method = method
        self.path = path
        self.query = query


def _host_allowed(authority: str, hosts: frozenset) -> bool:
    """`host` or `host:443`, no userinfo, on the allowlist."""
    authority = authority.lower()
    if "@" in authority or not authority:
        return False
    host, _, port = authority.partition(":")
    return host in hosts and port in ("", "443")


def _tokens(command: str) -> Optional[list[str]]:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=_PUNCTUATION)
        lexer.whitespace = " \t\r"  # a newline separates commands: an operator, not a space
        lexer.whitespace_split = True
        return list(lexer)
    except ValueError:
        return None


def _curl_segment(tokens: list[str]) -> Optional[list[str]]:
    """The arguments of the one `curl` command, or None unless there is exactly one.

    A `curl` word anywhere else — `echo curl …`, a `for` body, a second
    command — makes the call ambiguous and it is not read. So does anything
    after it: a pipe, `;`, `&&`, `||`, a redirect or a new line could run a
    second request, or rewrite what the agent saw as the response.
    """
    starts = [i for i, t in enumerate(tokens) if t == "curl" or t.endswith("/curl")]
    if len(starts) != 1:
        return None
    start = starts[0]
    if start > 0 and not _is_operator(tokens[start - 1]):
        return None
    segment = tokens[start + 1:]
    if any(_is_operator(token) for token in segment):
        return None
    return segment


def _parse_curl(args: list[str]) -> Optional[tuple[str, list[str]]]:
    """(METHOD, [url arguments]) from curl's argv, or None if it cannot be read."""
    method_x: Optional[str] = None
    get = data = upload = False
    urls: list[str] = []
    i = 0
    while i < len(args):
        token = args[i]
        i += 1
        if token == "--":
            urls.extend(args[i:])
            break
        if token.startswith("--"):
            name, eq, value = token.partition("=")
            if name in _REFUSED_LONG:
                return None
            if name in _LONG_WITH_ARG and not eq:
                if i >= len(args):
                    return None
                value = args[i]
                i += 1
            if name == "--request":
                method_x = value
            elif name == "--get":
                get = True
            elif name == "--url":
                urls.append(value)
            elif name == "--upload-file":
                upload = True
            elif name in _DATA_LONG:
                data = True
        elif token.startswith("-") and len(token) > 1:
            for j in range(1, len(token)):
                flag = token[j]
                if flag in _REFUSED_SHORT:
                    return None
                if flag in _SHORT_WITH_ARG:
                    value = token[j + 1:]
                    if not value:
                        if i >= len(args):
                            return None
                        value = args[i]
                        i += 1
                    if flag == "X":
                        method_x = value
                    elif flag in _DATA_SHORT:
                        data = True
                    elif flag == "T":
                        upload = True
                    break
                if flag == "G":
                    get = True
        else:
            urls.append(token)
    if method_x is not None:  # -X wins over everything, as it does in curl
        method = method_x.strip().upper()
    elif get:
        method = "GET"
    elif upload:
        method = "PUT"
    elif data:
        method = "POST"
    else:
        method = "GET"
    return method, urls


def http_call(tool_name: Any, args: Any, allowlist: Allowlist = ALLOWLIST) -> Optional[HttpCall]:
    """The one EdgeOS request a carrier tool call makes, or None.

    None whenever it is ambiguous or foreign: not a carrier tool; any http(s)
    URL in the command on a host other than EdgeOS (or on a port other than
    443); not exactly one `curl`, at the start of a command; not exactly one
    URL argument; two different EdgeOS paths anywhere in the command, headers
    included. An unrecognised call only loses a label; a misread one would
    invent an RSVP.
    """
    if not isinstance(tool_name, str) or tool_name not in allowlist.carriers or not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) or not command or len(command) > MAX_COMMAND_CHARS:
        return None
    if "`" in command or "$(" in command:  # command substitution: the shell decides, not us
        return None
    authorities = [m.group(1) for m in _ANY_URL.finditer(command)]
    if not authorities or not all(_host_allowed(a, allowlist.hosts) for a in authorities):
        return None
    tokens = _tokens(command)
    if tokens is None:
        return None
    segment = _curl_segment(tokens)
    if segment is None:
        return None
    parsed = _parse_curl(segment)
    if parsed is None:
        return None
    method, urls = parsed
    if len(urls) != 1:
        return None
    split = urllib.parse.urlsplit(urls[0])
    if split.scheme.lower() not in ("http", "https") or not _host_allowed(split.netloc, allowlist.hosts):
        return None
    path = split.path.rstrip("/") or "/"
    # Every EdgeOS URL in the command must name this path: one in a header
    # (`-H "Referer: …"`) that names another is a second request in disguise.
    for match in re.finditer(r"https?://[^/\s'\"`<>|;&()\\]*(/[^\s'\"`?#<>|;&()\\]*)", command, re.IGNORECASE):
        if (match.group(1).rstrip("/") or "/") != path:
            return None
    return HttpCall(method, path, parse_query(split.query))


def parse_query(query: str) -> dict:
    """The query string as {name: first value}. A literal `+` stays a `+`:
    `occurrence_start=2026-10-20T15:30:00+05:30` is an offset, not a space."""
    out: dict = {}
    for name, value in urllib.parse.parse_qsl(query.replace("+", "%2B"), keep_blank_values=True):
        out.setdefault(name, value)
    return out


def match_operation(call: HttpCall, allowlist: Allowlist = ALLOWLIST) -> Optional[tuple[Operation, dict]]:
    for op in allowlist.operations:
        if op.method != call.method:
            continue
        found = op.pattern.match(call.path)
        if found:
            return op, {k: v.lower() for k, v in found.groupdict().items()}
    return None


def terminal_outcome(result: Any) -> tuple[Optional[int], Any]:
    """(exit_code, the response body as JSON) from a `terminal` result.

    Hermes's terminal tool returns `{"output", "exit_code", "error"}` as JSON
    (`tools/terminal_tool.py` at `v2026.8.31`); `curl -s` puts the response
    body in `output`. Body is None when it is not JSON.
    """
    outer = _first_json(result)
    if not isinstance(outer, dict):
        return None, None
    code = outer.get("exit_code")
    exit_code = code if isinstance(code, int) and not isinstance(code, bool) else None
    output = outer.get("output")
    body = _first_json(output) if isinstance(output, str) else None
    return exit_code, body if isinstance(body, (dict, list)) else None


def action_error(status_ok: bool, status: Optional[str], exit_code: Optional[int], body: Any) -> Optional[str]:
    """A short, fixed error label for a failed EdgeOS action, or None.

    Labels only — never EdgeOS's own error text, which can echo the request.
    """
    if not status_ok:
        return f"tool_{status or 'error'}"
    if exit_code not in (None, 0):
        return "exit_nonzero"
    if isinstance(body, dict) and "id" not in body and any(k in body for k in ("detail", "error", "message")):
        return "edgeos_error"
    return None


def participant_record(body: Any, event_id: str) -> Optional[dict]:
    """The EventParticipant record an RSVP or cancellation answered with, or None.

    The one piece of positive evidence the action landed: a JSON object with a
    UUID `id`, no error key, and — when it names one — this event.
    """
    if not isinstance(body, dict) or "detail" in body or "error" in body:
        return None
    participant = body.get("id")
    if not (isinstance(participant, str) and UUID_RE.match(participant)):
        return None
    named = body.get("event_id")
    if named is not None and (not isinstance(named, str) or named.lower() != event_id):
        return None
    return body


def occurrence_of(value: Any) -> Optional[str]:
    """An occurrence start as UTC ISO; "" for the event as a whole (absent or
    null); None when there is a value but it is not a timestamp with a zone —
    an occurrence we cannot name is not keyed at all."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return ""
    if not isinstance(value, str):
        return None
    return iso_from_text(value)


def rsvp_statuses(body: Any, query: dict) -> list[tuple[str, Optional[str], Optional[str]]]:
    """[(EdgeOS event id, occurrence, `my_rsvp_status`)] for every event object in a read.

    A single event (`GET /events/portal/events/{id}`, whose occurrence is the
    `occurrence_start` query parameter, or None when the read names none) or a
    list (`{"results": [...]}`, where an item of a recurring series is keyed by
    its `start_time`). An object without the `my_rsvp_status` key says nothing
    about the caller and is skipped, as is one whose occurrence cannot be named.
    """
    single = isinstance(body, dict) and not isinstance(body.get("results"), list)
    items = [body] if single else (body.get("results") if isinstance(body, dict) else body)
    out = []
    for item in items if isinstance(items, list) else ():
        if not isinstance(item, dict) or "my_rsvp_status" not in item:
            continue
        event_id = item.get("id")
        status = item.get("my_rsvp_status")
        if not (isinstance(event_id, str) and UUID_RE.match(event_id)) or not (status is None or isinstance(status, str)):
            continue
        occurrence: Optional[str]
        if single:
            named = query.get("occurrence_start")
            occurrence = None if named is None else occurrence_of(named)
            if named is not None and not occurrence:
                continue
        elif item.get("recurrence_master_id") or item.get("occurrence_id") or item.get("rrule"):
            occurrence = occurrence_of(item.get("start_time"))
            if not occurrence:
                continue
        else:
            occurrence = ""
        out.append((event_id.lower(), occurrence, status.strip().lower() if isinstance(status, str) else None))
    return out


# --------------------------------------------------------------------------
# Ledger: pending actions awaiting a confirming read
# --------------------------------------------------------------------------


def ledger_key(event_id: str, occurrence: str) -> str:
    return f"{event_id}|{occurrence}"


def _valid_pending(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    at = value.get("at")
    reverses = value.get("reverses_action_id")
    participant = value.get("participant_id")
    return (
        valid_id(value.get("action_id"))
        and value.get("action_class") in CONFIRMS
        and isinstance(at, (int, float)) and not isinstance(at, bool)
        and isinstance(value.get("reversal"), bool)
        and (reverses is None or valid_id(reverses))
        and isinstance(participant, str) and UUID_RE.match(participant) is not None
    )


def _valid_last(value: Any) -> bool:
    return isinstance(value, dict) and all(k in CONFIRMS and valid_id(v) for k, v in value.items())


def _valid_key(key: Any) -> bool:
    if not isinstance(key, str) or "|" not in key:
        return False
    event_id, _, occurrence = key.partition("|")
    return UUID_RE.match(event_id) is not None and (occurrence == "" or iso_from_text(occurrence) == occurrence)


class Ledger:
    """What the plugin must remember between an RSVP and the read that confirms it.

    Keyed by EdgeOS event id and occurrence start (`"" ` for a one-off event).
    `pending`: the action waiting for a confirming read. `last`:
    {action_class: action_id} of the latest action that landed, so a
    cancellation can name the RSVP it reverses. Persisted as one small JSON
    file under `$HERMES_HOME/av-events/`, written only after the events that
    change it are buffered. Anything malformed on disk is dropped on load.
    """

    def __init__(self) -> None:
        self.pending: "OrderedDict[str, dict]" = OrderedDict()
        self.last: "OrderedDict[str, dict]" = OrderedDict()
        self.loaded = False

    def load(self, path: str) -> None:
        if self.loaded:
            return
        self.loaded = True
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError, RecursionError):
            return
        if not isinstance(data, dict):
            return
        for section, target, check in (("pending", self.pending, _valid_pending), ("last", self.last, _valid_last)):
            entries = data.get(section)
            if isinstance(entries, dict):
                for key, value in entries.items():
                    if _valid_key(key) and check(value):
                        target[key] = value
        self.trim()

    def save(self, path: str) -> None:
        tmp = f"{path}.{os.getpid()}.tmp"
        try:
            os.makedirs(os.path.dirname(path), mode=DIR_MODE, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"pending": self.pending, "last": self.last}, handle, separators=(",", ":"))
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def trim(self, now: Optional[float] = None) -> None:
        now = time.time() if now is None else now
        for key in [k for k, v in self.pending.items() if now - float(v["at"]) > PENDING_TTL_S]:
            self.pending.pop(key, None)
        for table in (self.pending, self.last):
            while len(table) > MAX_LEDGER_ENTRIES:
                table.popitem(last=False)

    def attempt(self, key: str, entry: dict) -> None:
        self.pending[key] = entry
        self.pending.move_to_end(key)
        latest = dict(self.last.get(key) or {})
        latest[entry["action_class"]] = entry["action_id"]
        self.last[key] = latest
        self.last.move_to_end(key)
        self.trim()

    def last_action(self, key: str, action_class: Optional[str]) -> Optional[str]:
        if not action_class:
            return None
        value = (self.last.get(key) or {}).get(action_class)
        return value if valid_id(value) else None


# --------------------------------------------------------------------------
# Planning
# --------------------------------------------------------------------------


class Planned:
    """One `action.*` event to emit, and the ledger change to make once it is buffered."""

    __slots__ = ("event_type", "payload", "action_id", "evidence_class", "apply")

    def __init__(self, event_type: str, payload: dict, action_id: str, evidence_class: Optional[str] = None,
                 apply: Optional[Callable[[], None]] = None) -> None:
        self.event_type = event_type
        self.payload = payload
        self.action_id = action_id
        self.evidence_class = evidence_class
        self.apply = apply


def action_payload(op: Operation, event_id: str, occurrence: str, *, error: Optional[str],
                   receipt: Optional[dict], reversal: bool, reverses_action_id: Optional[str],
                   action_class: Optional[str] = None, supersedes_action_id: Optional[str] = None,
                   version: Optional[str] = None) -> dict:
    """§4.1 `action.*`: `action_class`, `target_system`, `receipt?`,
    `execution_token_id?`, `error?`, plus the two fields `core.action_action`
    reads — `reversal` and `reverses_action_id`. Every key always present.

    Not in §4.1: `operation`, `edgeos_event_id`, `occurrence_start`,
    `supersedes_action_id`, `allowlist_version`.
    """
    return {
        "action_class": action_class or op.action_class,
        "target_system": TARGET_SYSTEM,
        "receipt": receipt,
        "execution_token_id": None,
        "error": error,
        "reverses_action_id": reverses_action_id,
        "reversal": reversal,
        "supersedes_action_id": supersedes_action_id,
        "operation": op.operation,
        "edgeos_event_id": event_id,
        "occurrence_start": occurrence or None,
        "allowlist_version": version,
    }


def plan(op: Operation, params: dict, call: HttpCall, *, ok: bool, status: Optional[str],
         exit_code: Optional[int], body: Any, ledger: Ledger, mint: Callable[[], str],
         now: Optional[float] = None) -> list[Planned]:
    """The `action.*` events one recognised EdgeOS call implies. No side effects:
    each ledger change rides on its `Planned.apply`, to run only once the event
    is buffered."""
    version = ALLOWLIST.version
    now = time.time() if now is None else now
    if op.role == "action":
        event_id = params.get("event_id")
        if not event_id:
            return []
        record = participant_record(body, event_id) if ok and exit_code in (None, 0) else None
        occurrence = occurrence_of(record.get("occurrence_start")) if record else ""
        if occurrence is None:
            # A record for an occurrence we cannot name: report the attempt,
            # wait on nothing.
            record, occurrence = None, ""
        key = ledger_key(event_id, occurrence)
        action_id = mint()
        reversal = bool(op.reverses)
        reverses = ledger.last_action(key, op.reverses) if reversal else None
        error = action_error(ok, status, exit_code, body)
        waiting = ledger.pending.get(key)
        supersedes = (
            waiting["action_id"] if record is not None and waiting and waiting["action_class"] == op.action_class
            else None
        )
        common = dict(receipt=None, reversal=reversal, reverses_action_id=reverses, version=version,
                      supersedes_action_id=supersedes)
        out = [Planned("action.attempted", action_payload(op, event_id, occurrence, error=None, **common), action_id)]
        if error is not None:
            out.append(Planned("action.failed", action_payload(op, event_id, occurrence, error=error, **common),
                               action_id))
        elif record is not None:
            entry = {
                "action_id": action_id,
                "action_class": op.action_class,
                "reversal": reversal,
                "reverses_action_id": reverses,
                "participant_id": record["id"].lower(),
                "at": now,
            }
            out[0].apply = lambda: ledger.attempt(key, entry)
        # No error and no record: the attempt is reported, and nothing waits on it.
        return out

    if not ok or exit_code not in (None, 0):
        return []
    out: list[Planned] = []
    for event_id, occurrence, rsvp in rsvp_statuses(body, call.query):
        if occurrence is None:
            # A single-event read naming no occurrence: the one-off action if
            # there is one, else the event's only waiting action, whichever
            # occurrence it is for. Two or more waiting occurrences: ambiguous.
            key = ledger_key(event_id, "")
            if key not in ledger.pending:
                candidates = [k for k in ledger.pending if k.startswith(f"{event_id}|")]
                if len(candidates) != 1:
                    continue
                key = candidates[0]
            occurrence = key.partition("|")[2]
        else:
            key = ledger_key(event_id, occurrence)
        waiting = ledger.pending.get(key)
        if not waiting:
            continue
        action_class = waiting["action_class"]
        confirms = rsvp in CONFIRMS[action_class] or (
            action_class == "cancel_rsvp" and rsvp is None and waiting["reverses_action_id"] is not None
        )
        if not confirms:
            continue
        receipt = {"kind": RECEIPT_KIND, "id": waiting["participant_id"]}
        payload = action_payload(
            op, event_id, occurrence, error=None, receipt=receipt, reversal=waiting["reversal"],
            reverses_action_id=waiting["reverses_action_id"], action_class=action_class, version=version,
        )
        out.append(Planned("action.receipted", payload, waiting["action_id"], "provider_receipt",
                           apply=lambda key=key: ledger.pending.pop(key, None)))
    return out


__all__ = [
    "ALLOWLIST",
    "CONFIRMS",
    "HttpCall",
    "Ledger",
    "Operation",
    "Planned",
    "RECEIPT_KIND",
    "TARGET_SYSTEM",
    "action_error",
    "action_payload",
    "http_call",
    "ledger_key",
    "load_allowlist",
    "match_operation",
    "occurrence_of",
    "parse_query",
    "participant_record",
    "plan",
    "rsvp_statuses",
    "terminal_outcome",
]
