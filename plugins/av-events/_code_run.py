"""`code.run@1`: what an `execute_code` call's program could do, as closed codes (P10-P1).

The outer `execute_code` call already leaves as a `tool.call` (`_tools.py`): its
arguments' keyed hash, their length and a status, nothing about the program. Since
rc42 `execute_code` is outside the approval hook (CODE-RUN-GATE research, row 7), so
nothing records what the program reached for. This module adds one event per
`execute_code` call, built in `post_tool_call` (a pure observer: Hermes discards its
return) from values that call already carries, and nothing else:

* `code_hmac`, `code_bytes`: the program's keyed hash (`Collector.keyed_hash`, the
  tenant's own HMAC key, as `tool.call.args_hash`) and its UTF-8 byte length. Both
  null in `metadata` capture, as `tool.call` drops its hashes and lengths there, and
  when the call carried no string `code`.
* `status`, `error_type`: the same closed values `tool.call` sends.
* `tool_calls_made`: the int Hermes puts in the result, or null.
* `unavailable_tool_refusals`, `unavailable_tools`: how many
  `Tool '<x>' is not available in execute_code` refusals the result's text holds
  (Hermes's RPC allowlist answer, `tools/code_execution_rpc.py`), and the distinct
  `<x>` as a sorted list: a name only when `tool_categories.json` lists it, any other
  name as `other`.
* `risk_tags`: a sorted list from `RISK_TAGS`, a closed set, computed here from the
  program text by plain regex checks. A tag means the text *could* do the thing, not
  that it did: the checks are static, can over-fire (a comment, a co-occurrence) and
  can be evaded (string building). `gated_host` matches the hosts the plugin already
  knows (`gated_hosts`); no host ever leaves.
* `scan_truncated`: true when the tags or the refusal count read only the first
  `SCAN_LIMIT` characters of the program or of a result text (the hash and the byte
  length always cover the whole program).
* `consent_scope`, `rules_version`, `category_version`: labels.

Never sent: the program, its output, a path, a host, an env name or value, any id
but the ones `tool.call` carries. Nothing here reads `.env` beyond the plugin's own
switch reader (`_core.env`), opens a file or touches the network.

Switches (`flag_on`, `scope`): `AV_EVENTS_CODE_RUN` (`1|true|yes|on`, `_core.env_flag_on`,
default off: off builds nothing) and `AV_EVENTS_CODE_RUN_SCOPE` (unset or blank:
`all`; exactly `all` or `research_consented`: itself; any other set value fails narrow
to `research_consented`, logged once per process by name). The scope rides in the
payload; the plugin sends the same event either way and agentvillage-data's worker
decides what it keeps (the `cron.run` precedent: an ops-allowlisted type kept without
research consent only when its payload says so).

Python 3.11, standard library only.
"""

from __future__ import annotations

import bisect
import json
import logging
import os
import re
import threading
import urllib.parse
from typing import Any, Callable, Iterable, Optional

from ._core import env, env_flag_on
from ._tools import TOOL_CATEGORIES, TOOL_CATEGORY_VERSION, normalise_status

logger = logging.getLogger("av-events")

TYPE = "code.run"
TOOL_NAME = "execute_code"
FLAG = "AV_EVENTS_CODE_RUN"
SCOPE_ENV = "AV_EVENTS_CODE_RUN_SCOPE"
SCOPE_ALL = "all"
SCOPE_RESEARCH = "research_consented"
SCOPES = (SCOPE_ALL, SCOPE_RESEARCH)

#: Bumped whenever a tag's rule changes, so data can tell rule sets apart.
RULES_VERSION = "code_run_tags_v1"

#: The closed tag set, in the order the brief lists them.
RISK_TAGS = (
    "dotenv_path",
    "proc_environ",
    "os_environ",
    "subprocess",
    "socket_or_http_client",
    "hermes_home_write",
    "scripts_dir_write",
    "cron_write",
    "gated_host",
    "base64_or_eval",
)

#: How much of the program, and of each result text, the tags and the refusal count
#: read (characters). The scans run synchronously in `post_tool_call`, at roughly
#: 250 ms per MB, so they are capped; the hash and the byte length still cover the
#: whole program, and `scan_truncated` says when a scan stopped short.
SCAN_LIMIT = 262144

#: Every count is capped here, so a pathological output cannot grow a field.
MAX_COUNT = 10000
#: `unavailable_tools`: at most this many names (data's `KERNEL_REFUSED_TOOLS_MAX`).
MAX_TOOL_NAMES = 16
OTHER_TOOL = "other"

#: The contract's shapes, applied with `fullmatch` only (never a bare `$`, which in
#: Python also accepts a trailing newline that data's door refuses). `error_type` is
#: `_tools._ERROR_TYPE`'s shape, checked here on its own so `tool.call` is unchanged.
_ERROR_TYPE_SHAPE = re.compile(r"[A-Za-z_][A-Za-z0-9_.]{0,63}")
_HMAC_SHAPE = re.compile(r"[0-9a-f]{64}")
_LABEL_SHAPE = re.compile(r"[a-z][a-z0-9_]{0,63}")
_TOOL_NAME_SHAPE = re.compile(r"[A-Za-z0-9_.:-]{1,128}")

#: Hermes's refusal for a tool outside the kernel's RPC allowlist
#: (`tools/code_execution_rpc.py`, `_handle_rpc_request`).
_REFUSAL = re.compile(r"Tool '([^'\n]{0,128})' is not available in execute_code")

# --------------------------------------------------------------------------
# Static tags.
#
# Every rule starts with a literal, and any word-boundary check comes after it as a
# fixed-width lookbehind, so `re` finds candidates with its fast literal-prefix
# search instead of trying the rule at every position. The rules that relate two
# places in the text (an `open(` and its mode, an `import` and a module, a
# `from os import` and a name) run in linear time (`_head_then_word`). The tag
# rules are those of rules_version code_run_tags_v1, unchanged: a test holds them
# to the round-1 regexes over every case and a seeded fuzz corpus.
# --------------------------------------------------------------------------


def _rx(*patterns: str) -> tuple:
    return tuple(re.compile(p) for p in patterns)


def _word(literal: str) -> str:
    """`\\b<literal>\\b` for a literal that starts and ends with a word character,
    written literal-first."""
    escaped = re.escape(literal)
    return escaped + r"(?<!\w" + escaped + r")(?!\w)"


def _any(rules: tuple, code: str) -> bool:
    return any(rule.search(code) for rule in rules)


#: `.env` as a path segment (not `os.environ`, not `self.env`, not `.venv`), or the dotenv package.
_DOTENV = _rx(
    r"\.env(?<![A-Za-z0-9_]\.env)(?![A-Za-z0-9_])",
    _word("dotenv"),
    _word("load_dotenv"),
    _word("dotenv_values"),
)

#: `/proc/<pid>/environ` (linear, `_proc_environ`), or psutil's `.environ()`;
#: or `'/proc'` together with `'environ'` (a join).
_PSUTIL_ENVIRON = _rx(r"\.environ\s*\(\s*\)")
_PROC_LITERAL = _rx(r"'/proc/?['\"]", r"\"/proc/?['\"]")
_ENVIRON_LITERAL = _rx(r"'environ['\"]", r"\"environ['\"]")
_PROC_HEAD = re.compile(r"/proc/")
_ENVIRON_TAIL = re.compile(r"environ(?!\w)")
_NO_SPACE_OR_QUOTE = re.compile(r"[^\s'\"]*")

#: The process's own environment; and `from os import ... environ` (linear).
_OS_ENVIRON = _rx(
    r"os(?<!\wos)\.environb?(?!\w)",
    r"getenv(?<!\wgetenv)\s*\(",
    r"posix(?<!\wposix)\.environ(?!\w)",
)
_FROM_OS_IMPORT = re.compile(r"from(?<!\wfrom)\s+os\s+import\s+")
_ENV_NAMES = re.compile(r"(?:environb|environ|getenv)(?!\w)")
_IMPORT_LIST = re.compile(r"[\w ,()]*")

#: A child process.
_SUBPROCESS = _rx(
    _word("subprocess"),
    r"os(?<!\wos)\.(?:system|popen|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?|fork|forkpty)\s*\(",
    r"pty(?<!\wpty)\.spawn(?!\w)",
    r"asyncio(?<!\wasyncio)\.create_subprocess_(?:exec|shell)(?!\w)",
)

_NET_MODULES = (
    r"socket|ssl|urllib|urllib3|http|requests|httpx|aiohttp|websocket|websockets"
    r"|ftplib|smtplib|telnetlib|pycurl|xmlrpc"
)
#: A socket or an HTTP client: imported (linear, `_head_then_word`), imported from,
#: imported dynamically, or used by name.
_NET = _rx(
    rf"from(?<!\wfrom)\s+(?:{_NET_MODULES})(?!\w)",
    rf"__import__\s*\(\s*['\"](?:{_NET_MODULES})(?!\w)",
    rf"import_module\s*\(\s*['\"](?:{_NET_MODULES})(?!\w)",
    r"asyncio(?<!\wasyncio)\.open_connection(?!\w)",
)
#: `\b(?:socket|urllib.request|...)\.<letter>`: the leading boundary is checked by hand.
_NET_ATTR = re.compile(r"(?:socket|urllib\.request|urllib3|requests|httpx|aiohttp|http\.client)\.[A-Za-z_]")
_IMPORT_HEAD = re.compile(r"import(?<!\wimport)\s+")
_NET_MODULE = re.compile(rf"(?:{_NET_MODULES})(?!\w)")
_DOTTED_LIST = re.compile(r"[\w ,.]*")

#: Something that writes, creates, moves or deletes a file; and an `open(` with a
#: write mode within 512 characters on its line (linear).
_WRITE = _rx(
    r"\.(?:write_text|write_bytes|touch|symlink_to|hardlink_to|mkdir|unlink)\s*\(",
    r"shutil(?<!\wshutil)\.(?:copy|copy2|copyfile|copytree|copyfileobj|move|rmtree)\s*\(",
    r"os(?<!\wos)\.(?:rename|renames|replace|symlink|link|makedirs|mkdir|chmod|remove|unlink|truncate)\s*\(",
    r"O(?<!\wO)_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)(?!\w)",
    r">(?<![>=<\-!]>)>?\s*(?:~/|\$\{?HERMES_HOME|/[A-Za-z])",
    r"tee(?<!\wtee)\s+(?:-a\s+)?[~$/]",
)
_OPEN_HEAD = re.compile(r"open(?<!\wopen)\s*\(")
_WRITE_MODE = re.compile(r",\s*(?:mode\s*=\s*)?['\"][rbt]*[wax+][rbt+]*['\"]")
_ONE_LINE = re.compile(r"[^\n]*")

#: Where the write lands, matched anywhere in the program (a co-occurrence).
_HERMES_HOME = _rx(r"HERMES_HOME", r"\.hermes(?<![A-Za-z0-9_]\.hermes)(?![A-Za-z0-9_])")
_SCRIPTS_DIR = _rx(r"scripts/(?<![A-Za-z0-9_]scripts/)", r"'scripts['\"]", r"\"scripts['\"]")
_CRON = _rx(
    r"cron/(?<![A-Za-z0-9_]cron/)",
    r"jobs(?<!\wjobs)\.json(?!\w)",
    _word("crontab"),
    r"/etc/cron",
    r"'cron['\"]",
    r"\"cron['\"]",
)

#: Decoding or running text as code.
_BASE64_EVAL = _rx(
    _word("base64"),
    *(_word(name) for name in ("b64decode", "b32decode", "b16decode", "b85decode", "a85decode", "urlsafe_b64decode")),
    r"eval(?<![\w.]eval)\s*\(",
    r"exec(?<![\w.]exec)\s*\(",
    r"compile(?<![\w.]compile)\s*\(",
    r"__import__(?<!\w__import__)\s*\(",
    r"marshal(?<!\wmarshal)\.loads(?!\w)",
)

_WORD_CHAR = re.compile(r"\w")


def _boundary_before(code: str, index: int) -> bool:
    """`\\b` before a word character at `index`: no word character just before it."""
    return index == 0 or _WORD_CHAR.match(code, index - 1) is None


def _bounded_attr(code: str) -> bool:
    """`_NET_ATTR` at a word boundary. A hit without one moves on by one character."""
    pos = 0
    while True:
        match = _NET_ATTR.search(code, pos)
        if match is None:
            return False
        if _boundary_before(code, match.start()):
            return True
        pos = match.start() + 1


def _head_then_word(code: str, heads: "re.Pattern[str]", words: "re.Pattern[str]",
                    span: "re.Pattern[str]", max_span: int, word_boundary: bool) -> bool:
    """Some `heads` match ends at `e`, a later `words` match starts at `p`, with
    `p - e <= max_span` and every character of `code[e:p]` in `span`.

    Linear: only the latest head before `p` can qualify (an earlier one has a longer,
    containing gap), and a head whose gap failed fails for every later word too, so
    each head's gap is read at most once."""
    ends = []
    start = 0
    while True:  # every head, overlapping ones included (`/proc/proc/`)
        head = heads.search(code, start)
        if head is None:
            break
        ends.append(head.end())
        start = head.start() + 1
    if not ends:
        return False
    failed: set[int] = set()
    pos = 0
    while True:
        match = words.search(code, pos)
        if match is None:
            return False
        p = match.start()
        pos = p + 1
        if word_boundary and not _boundary_before(code, p):
            continue
        i = bisect.bisect_right(ends, p) - 1
        if i < 0:
            continue
        e = ends[i]
        if p - e > max_span or e in failed:
            continue
        if span.fullmatch(code, e, p) is not None:
            return True
        failed.add(e)


def _proc_environ(code: str) -> bool:
    return (
        _head_then_word(code, _PROC_HEAD, _ENVIRON_TAIL, _NO_SPACE_OR_QUOTE, 64, False)
        or _any(_PSUTIL_ENVIRON, code)
        or (_any(_PROC_LITERAL, code) and _any(_ENVIRON_LITERAL, code))
    )


def _os_environ(code: str) -> bool:
    return _any(_OS_ENVIRON, code) or _head_then_word(code, _FROM_OS_IMPORT, _ENV_NAMES, _IMPORT_LIST, 200, True)


def _net(code: str) -> bool:
    return (
        _any(_NET, code)
        or _bounded_attr(code)
        or _head_then_word(code, _IMPORT_HEAD, _NET_MODULE, _DOTTED_LIST, 200, True)
    )


def _write(code: str) -> bool:
    return _any(_WRITE, code) or _head_then_word(code, _OPEN_HEAD, _WRITE_MODE, _ONE_LINE, 512, False)


#: Hosts the program may not reach around the gate, whatever the env says.
#: Telegram's Bot API and OpenRouter are not in the plugin's env (the agent's own
#: keys reach them), so they are named here; the others are the plugin's own pins.
FIXED_GATED_HOSTS = ("index.network", "edgeos.world", "api.telegram.org", "openrouter.ai")
_HOSTNAME = re.compile(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+")


def flag_on() -> bool:
    """`AV_EVENTS_CODE_RUN`: the plugin's one on-switch reader. Unset, blank, `0`
    or anything not `1|true|yes|on` is off."""
    return env_flag_on(FLAG)


_SCOPE_LOCK = threading.Lock()
#: How many reads found the scope variable set to something unrecognised (this process).
SCOPE_UNRECOGNISED = [0]


def scope() -> str:
    """`AV_EVENTS_CODE_RUN_SCOPE`, read as every av-events variable is (`_core.env`,
    stripped). Unset or blank: `all`, the lead's default (CLAIMS L12710). Exactly `all`
    or `research_consented`: itself. Anything else that is set (a typo, `research`, a
    different case, a homoglyph) fails NARROW to `research_consented`, with one
    WARNING per process that names the variable and a count, never its value."""
    value = env(SCOPE_ENV).strip()
    if not value:
        return SCOPE_ALL
    if value in SCOPES:
        return value
    with _SCOPE_LOCK:
        SCOPE_UNRECOGNISED[0] += 1
        first = SCOPE_UNRECOGNISED[0] == 1
    if first:
        logger.warning("av-events: %s unrecognised=1, read as %s", SCOPE_ENV, SCOPE_RESEARCH)
    return SCOPE_RESEARCH


def _host_of(url: Any) -> Optional[str]:
    if not isinstance(url, str) or not url.strip():
        return None
    try:
        host = (urllib.parse.urlsplit(url.strip()).hostname or "").lower()
    except ValueError:
        return None
    return host if _HOSTNAME.fullmatch(host) else None


def gated_hosts() -> frozenset:
    """The fixed hosts, plus those the plugin already pins or reads for its own calls:
    EdgeOS's seed hosts and `EDGEOS_API_BASE` (`_edgeos`), the control plane's
    `CP_HOSTS` and `CONTROL_PLANE_URL` (`_pray`), Index's REST origin (`_record_intention.api_origin`).
    Each read is wrapped: a failure costs that host, never the event."""
    hosts = set(FIXED_GATED_HOSTS)
    try:
        from . import _edgeos

        hosts.update(h for h in _edgeos.ALLOWLIST.hosts if _HOSTNAME.fullmatch(h))
        # Process environment only, as `_edgeos._base_value` reads it.
        host = _host_of(os.environ.get("EDGEOS_API_BASE"))
        if host:
            hosts.add(host)
    except Exception:  # noqa: BLE001 - a host lost, not the event
        pass
    try:
        from . import _pray

        hosts.update(h for h in _pray.CP_HOSTS if _HOSTNAME.fullmatch(h))
        host = _host_of(env(_pray.URL_ENV))
        if host:
            hosts.add(host)
    except Exception:  # noqa: BLE001
        pass
    try:
        from . import _record_intention

        origin, _ = _record_intention.api_origin()
        host = _host_of(origin)
        if host:
            hosts.add(host)
    except Exception:  # noqa: BLE001
        pass
    return frozenset(hosts)


_HOST_EDGE = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-")


def _mentions_host(lowered: str, hosts: Iterable[str]) -> bool:
    """A host named as a whole host or a subdomain of it (`api.index.network` names
    `index.network`; `myindex.network` does not). `str.find` per host: linear."""
    for host in hosts:
        if not (isinstance(host, str) and _HOSTNAME.fullmatch(host)):
            continue
        index = lowered.find(host)
        while index != -1:
            end = index + len(host)
            if (index == 0 or lowered[index - 1] not in _HOST_EDGE) and (
                end == len(lowered) or lowered[end] not in _HOST_EDGE
            ):
                return True
            index = lowered.find(host, index + 1)
    return False


#: Literals every match of a pattern contains: a pattern runs only when one of its
#: literals is in the text (a C-speed `in`), so the common program pays for a few
#: substring checks, not a dozen regex scans. A gate never changes a result.
_GATE_DOTENV = (".env", "dotenv")
_GATE_ENVIRON = ("environ",)
_GATE_OS_ENVIRON = ("environ", "getenv")
_GATE_SUBPROCESS = ("subprocess", "os.", "pty.spawn")
_GATE_NET = ("socket", "ssl", "urllib", "http", "requests", "aiohttp", "ftplib", "smtplib", "telnetlib", "pycurl",
             "xmlrpc", "open_connection")
_GATE_WRITE = ("open", "write_", "touch", "link", "mkdir", "shutil.", "os.", "O_", ">", "tee")
_GATE_HERMES_HOME = ("HERMES_HOME", ".hermes")
_GATE_SCRIPTS = ("scripts",)
_GATE_CRON = ("cron", "jobs.json")
_GATE_BASE64_EVAL = ("base64", "decode", "eval", "exec", "compile", "__import__", "marshal")


def _has(code: str, literals: tuple) -> bool:
    return any(literal in code for literal in literals)


def risk_tags(code: str, hosts: Iterable[str] = ()) -> list[str]:
    """The sorted tags `code` carries; [] for empty code. Never raises on a str.

    The caller caps `code` at `SCAN_LIMIT`; this function reads all it is given, in
    time linear in its length."""
    if not code:
        return []
    hosts = tuple(hosts)
    tags: set[str] = set()
    if _has(code, _GATE_DOTENV) and _any(_DOTENV, code):
        tags.add("dotenv_path")
    if _has(code, _GATE_ENVIRON) and _proc_environ(code):
        tags.add("proc_environ")
    if _has(code, _GATE_OS_ENVIRON) and _os_environ(code):
        tags.add("os_environ")
    if _has(code, _GATE_SUBPROCESS) and _any(_SUBPROCESS, code):
        tags.add("subprocess")
    if _has(code, _GATE_NET) and _net(code):
        tags.add("socket_or_http_client")
    # Where a write would land first (cheap, rare), and only then whether there is a write.
    places = []
    if _has(code, _GATE_HERMES_HOME) and _any(_HERMES_HOME, code):
        places.append("hermes_home_write")
    if _has(code, _GATE_SCRIPTS) and _any(_SCRIPTS_DIR, code):
        places.append("scripts_dir_write")
    if _has(code, _GATE_CRON) and _any(_CRON, code):
        places.append("cron_write")
    if places and _has(code, _GATE_WRITE) and _write(code):
        tags.update(places)
    if _mentions_host(code.lower(), hosts):
        tags.add("gated_host")
    if _has(code, _GATE_BASE64_EVAL) and _any(_BASE64_EVAL, code):
        tags.add("base64_or_eval")
    return sorted(tags)


def _result_texts(result: Any) -> tuple[list[str], Optional[dict]]:
    """(the texts to scan for refusals, the parsed result dict or None).

    Hermes returns JSON: `output` (stdout, with stderr and any traceback joined in)
    and, on a failure, `error`. Those two are scanned once each. A result that is not
    a JSON object is scanned whole, as a string."""
    if isinstance(result, dict):
        parsed: Optional[dict] = result
    elif isinstance(result, str):
        try:
            loaded = json.loads(result)
        except (ValueError, RecursionError):
            loaded = None
        parsed = loaded if isinstance(loaded, dict) else None
        if parsed is None:
            return [result], None
    else:
        return [], None
    texts = [parsed[k] for k in ("output", "error") if isinstance(parsed.get(k), str)]
    return texts, parsed


def refusals(texts: Iterable[str]) -> tuple[int, list[str]]:
    """(count, sorted distinct names) of the RPC refusals in `texts`. A name leaves
    only when `tool_categories.json` lists it; any other is `other`."""
    count = 0
    names: set[str] = set()
    for text in texts:
        for match in _REFUSAL.finditer(text):
            count += 1
            name = match.group(1)
            listed = name in TOOL_CATEGORIES and _TOOL_NAME_SHAPE.fullmatch(name) is not None
            names.add(name if listed else OTHER_TOOL)
            if count >= MAX_COUNT:
                break
        if count >= MAX_COUNT:
            break
    ordered = sorted(names)
    if len(ordered) > MAX_TOOL_NAMES:
        keep = [n for n in ordered if n != OTHER_TOOL][: MAX_TOOL_NAMES - 1]
        ordered = sorted(keep + [OTHER_TOOL])
    return min(count, MAX_COUNT), ordered


def _bounded_count(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= MAX_COUNT else None


def code_of(args: Any) -> Optional[str]:
    """The program as Hermes runs it: `args["code"]` when it is a string."""
    if isinstance(args, dict):
        code = args.get("code")
        return code if isinstance(code, str) else None
    return None


def code_run_payload(
    args: Any,
    result: Any,
    status: Any,
    error_type: Any,
    capture: str,
    hasher: Callable[[str], Optional[str]],
    consent_scope: str,
    hosts: Iterable[str] = (),
) -> dict:
    """`code.run@1`: every key always present, in this order, null when unknown."""
    code = code_of(args)
    texts, parsed = _result_texts(result)
    truncated = (code is not None and len(code) > SCAN_LIMIT) or any(len(t) > SCAN_LIMIT for t in texts)
    refused, refused_names = refusals(t[:SCAN_LIMIT] for t in texts)
    raw_error = error_type if isinstance(error_type, str) else None
    keyed = capture != "metadata" and code is not None
    digest = hasher(code) if keyed else None
    category = TOOL_CATEGORY_VERSION
    return {
        "consent_scope": consent_scope if consent_scope in SCOPES else SCOPE_ALL,
        "code_hmac": digest if isinstance(digest, str) and _HMAC_SHAPE.fullmatch(digest) else None,
        "code_bytes": len(code.encode("utf-8", errors="surrogatepass")) if keyed else None,
        "status": normalise_status(status),
        "error_type": raw_error if raw_error and _ERROR_TYPE_SHAPE.fullmatch(raw_error) else None,
        "tool_calls_made": _bounded_count(parsed.get("tool_calls_made")) if parsed is not None else None,
        "unavailable_tool_refusals": refused,
        "unavailable_tools": refused_names,
        "risk_tags": risk_tags((code or "")[:SCAN_LIMIT], hosts),
        "scan_truncated": truncated,
        "rules_version": RULES_VERSION,
        "category_version": category if isinstance(category, str) and _LABEL_SHAPE.fullmatch(category) else None,
    }


#: The payload's keys, in order (the contract's field list; a test holds them together).
FIELD_NAMES = (
    "consent_scope",
    "code_hmac",
    "code_bytes",
    "status",
    "error_type",
    "tool_calls_made",
    "unavailable_tool_refusals",
    "unavailable_tools",
    "risk_tags",
    "scan_truncated",
    "rules_version",
    "category_version",
)

__all__ = [
    "FIELD_NAMES",
    "FLAG",
    "RISK_TAGS",
    "RULES_VERSION",
    "SCOPE_ENV",
    "SCOPES",
    "TOOL_NAME",
    "TYPE",
    "code_run_payload",
    "flag_on",
    "gated_hosts",
    "refusals",
    "risk_tags",
    "scope",
]
