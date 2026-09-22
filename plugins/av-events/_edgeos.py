"""The EdgeOS action path: RSVP → `action.attempted`, confirming read → `action.receipted`.

Spec §4.1 `action.attempted/receipted/failed`, §2.1's receipt allowance
(`receipt.kind = edgeos_confirming_read`), and the measurement catalogue's
"Act on intentions (RSVP)" row.

The `edgeos` skill reaches EdgeOS by running `curl` through Hermes's `terminal`
tool (`skills/edgeos/SKILL.md` §6); there is no EdgeOS tool with its own name.
So an EdgeOS operation is recognised by the HTTP method and path of the one
EdgeOS URL in a carrier tool's command, against the frozen seed
`edgeos_tool_allowlist.json`. Nothing of the command, the headers or the
response body leaves the sandbox: the only values that do are the operation
name, the EdgeOS event id (a UUID, validated as one) and the ids minted here.

Everything here is pure except `Ledger.load` / `Ledger.save`, which the
collector calls from `post_tool_call` only when an EdgeOS action is seen.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections import OrderedDict
from typing import Any, Optional

from ._core import DIR_MODE, FILE_MODE
from ._intentions import _first_json

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

#: `my_rsvp_status` values that confirm each action class. For a
#: cancellation, `None` (the key present, the value null) means "not
#: registered", which is what a cancelled RSVP reads as.
CONFIRMS: dict[str, frozenset] = {
    "rsvp": frozenset({"registered", "checked_in"}),
    "cancel_rsvp": frozenset({"cancelled", None}),
}

#: Pending actions and last-known RSVP actions kept, per map.
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
    __slots__ = ("version", "hosts", "carriers", "operations", "url_re")

    def __init__(self, version: Optional[str], hosts: frozenset, carriers: frozenset, operations: list) -> None:
        self.version = version
        self.hosts = hosts
        self.carriers = carriers
        self.operations = operations
        alternatives = "|".join(re.escape(host) for host in sorted(hosts)) or r"(?!)"
        # The path runs until whitespace or a shell metacharacter: a quote, a
        # backslash, a pipe, `;`, `&`, `)`, `<`, `>` or a backtick.
        self.url_re = re.compile(rf"https?://(?:{alternatives})(/[^\s'\"\\`<>|;&)]*)", re.IGNORECASE)


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

_CURL = re.compile(r"(?<![\w.-])curl(?![\w.-])")
_METHOD = re.compile(r"(?:^|\s)(?:-X\s*|--request(?:\s+|=))['\"]?([A-Za-z]+)")
_DATA = re.compile(r"(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|-F|--form)(?=\s|=|'|\"|$)")


def http_call(tool_name: Any, args: Any, allowlist: Allowlist = ALLOWLIST) -> Optional[tuple[str, str]]:
    """(METHOD, path) of the one EdgeOS request a carrier tool call makes, or None.

    None whenever it is ambiguous: not a carrier tool, not exactly one `curl`,
    not exactly one distinct EdgeOS path, or two different `-X` methods. An
    unrecognised call only loses a label; a misread one would invent an RSVP.
    """
    if not isinstance(tool_name, str) or tool_name not in allowlist.carriers or not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) or not command or len(command) > MAX_COMMAND_CHARS:
        return None
    if len(_CURL.findall(command)) != 1:
        return None
    paths = {match.group(1).split("?", 1)[0].split("#", 1)[0] for match in allowlist.url_re.finditer(command)}
    paths = {p.rstrip("/") or "/" for p in paths}
    if len(paths) != 1:
        return None
    methods = {m.upper() for m in _METHOD.findall(command)}
    if len(methods) > 1:
        return None
    method = methods.pop() if methods else ("POST" if _DATA.search(command) else "GET")
    return method, paths.pop()


def match_operation(method: str, path: str, allowlist: Allowlist = ALLOWLIST) -> Optional[tuple[Operation, dict]]:
    for op in allowlist.operations:
        if op.method != method:
            continue
        found = op.pattern.match(path)
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

    Labels only — never EdgeOS's `detail`, which can echo the request.
    """
    if not status_ok:
        return f"tool_{status or 'error'}"
    if exit_code not in (None, 0):
        return "exit_nonzero"
    if isinstance(body, dict) and ("detail" in body or "error" in body) and "id" not in body:
        return "edgeos_error"
    return None


def rsvp_statuses(body: Any) -> dict[str, Any]:
    """{EdgeOS event id: `my_rsvp_status`} for every event object in a read.

    A single event (`GET /events/portal/events/{id}`) or a list
    (`{"results": [...]}`). An object without the `my_rsvp_status` key says
    nothing about the caller's RSVP and is skipped.
    """
    items: list = []
    if isinstance(body, dict):
        results = body.get("results")
        items = results if isinstance(results, list) else [body]
    elif isinstance(body, list):
        items = body
    out: dict[str, Any] = {}
    for item in items:
        if not isinstance(item, dict) or "my_rsvp_status" not in item:
            continue
        event_id = item.get("id")
        status = item.get("my_rsvp_status")
        if isinstance(event_id, str) and UUID_RE.match(event_id) and (status is None or isinstance(status, str)):
            out[event_id.lower()] = status.strip().lower() if isinstance(status, str) else None
    return out


# --------------------------------------------------------------------------
# Ledger: pending actions awaiting a confirming read
# --------------------------------------------------------------------------


class Ledger:
    """What the plugin must remember between an RSVP and the read that confirms it.

    `pending`: EdgeOS event id → the action waiting for a confirming read.
    `last`: EdgeOS event id → {action_class: action_id} of the latest action,
    so a cancellation can name the RSVP it reverses. Persisted as one small
    JSON file under `$HERMES_HOME/av-events/`, written only when an EdgeOS
    action or receipt changes it — a gateway restart between the RSVP and the
    read must not lose the link.
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
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        for key, target in (("pending", self.pending), ("last", self.last)):
            section = data.get(key)
            if isinstance(section, dict):
                for event_id, value in section.items():
                    if isinstance(event_id, str) and UUID_RE.match(event_id) and isinstance(value, dict):
                        target[event_id] = value
        self._trim()

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

    def _trim(self, now: Optional[float] = None) -> None:
        now = time.time() if now is None else now
        for event_id in [k for k, v in self.pending.items() if now - float(v.get("at") or 0) > PENDING_TTL_S]:
            self.pending.pop(event_id, None)
        for table in (self.pending, self.last):
            while len(table) > MAX_LEDGER_ENTRIES:
                table.popitem(last=False)

    def attempt(self, event_id: str, action_id: str, action_class: str, reversal: bool,
                reverses_action_id: Optional[str]) -> None:
        self.pending[event_id] = {
            "action_id": action_id,
            "action_class": action_class,
            "reversal": reversal,
            "reverses_action_id": reverses_action_id,
            "at": time.time(),
        }
        self.pending.move_to_end(event_id)
        latest = dict(self.last.get(event_id) or {})
        latest[action_class] = action_id
        self.last[event_id] = latest
        self.last.move_to_end(event_id)
        self._trim()

    def last_action(self, event_id: str, action_class: Optional[str]) -> Optional[str]:
        if not action_class:
            return None
        value = (self.last.get(event_id) or {}).get(action_class)
        return value if isinstance(value, str) else None

    def resolve(self, event_id: str) -> Optional[dict]:
        return self.pending.pop(event_id, None)


def action_payload(op: Operation, event_id: str, *, error: Optional[str], receipt: Optional[dict],
                   reversal: bool, reverses_action_id: Optional[str], action_class: Optional[str] = None,
                   version: Optional[str] = None) -> dict:
    """§4.1 `action.*`: `action_class`, `target_system`, `receipt?`,
    `execution_token_id?`, `error?`, plus the two fields `core.action_action`
    reads — `reversal` and `reverses_action_id`. Every key always present.

    Not in §4.1: `operation`, `edgeos_event_id`, `allowlist_version`.
    """
    return {
        "action_class": action_class or op.action_class,
        "target_system": TARGET_SYSTEM,
        "receipt": receipt,
        "execution_token_id": None,
        "error": error,
        "reverses_action_id": reverses_action_id,
        "reversal": reversal,
        "operation": op.operation,
        "edgeos_event_id": event_id,
        "allowlist_version": version,
    }


__all__ = [
    "ALLOWLIST",
    "CONFIRMS",
    "Ledger",
    "Operation",
    "RECEIPT_KIND",
    "TARGET_SYSTEM",
    "action_error",
    "action_payload",
    "http_call",
    "load_allowlist",
    "match_operation",
    "rsvp_statuses",
    "terminal_outcome",
]
