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
name, the EdgeOS event id (a UUID, validated as such; its keyed hash in
`metadata`), the keyed hash of the participant record id (DATA-308: never the
UUID itself, in any capture mode; the caller keys it), an occurrence
timestamp, and the ids minted here.

**The command that ran is the command that was read.** A metric counts these
receipts as verified outcomes, so a command is classified only when the shell
would run exactly the curl this module reads, and when in doubt it is not
classified (the `tool.call` is still recorded, without an operation):

- the curl is the whole command: its first word is `curl` and nothing comes
  before it — no `cd`, assignment, `export`/`unset`, other command or
  here-document, any of which can decide whether it runs or where it goes;
  after a read only `2>&1`, `| jq …` and newlines may follow, after a write
  nothing;
- the shell's words are the tokeniser's: backslash-newline is removed as the
  shell removes it, and anything else the shell would expand or reinterpret
  (a `$` other than the base reference below, `$'…'`, unquoted braces or glob
  characters, `#`, backticks, a carriage return) is refused;
- the base is named only as the skill's recipes name it — `$EDGEOS_API_BASE`,
  `${EDGEOS_API_BASE}`, or `${EDGEOS_API_BASE:-<default>}` with `<default>`
  exactly the plugin's default — and is expanded from *this process's*
  `EDGEOS_API_BASE`, which must itself be an https URL on an allowlisted
  EdgeOS authority (else nothing naming the base is read: a dev tunnel gets
  no labels). Without a default and with the variable unset, the shell
  sends a host-less URL: not read;
- every curl option is one this module can follow: none that moves the
  request, changes the method (`-I`, a lower-case `-X post`, which curl sends
  as written), builds the URL (`--variable`, `--expand-*`), or does not exist
  (`--name=value`); options that divert the body or add to stdout (`-o`,
  `-w`, `-v`, `-i`, `--trace`, …) keep the label but make the output
  untrusted, like `| jq`.

**What an observer cannot see.** The plugin reads its own environment; the
shell reads the one the terminal tool gives it. Hermes's local terminal
spawns each command from the Hermes process's environment (the one this
plugin is loaded in), but it also carries a session snapshot of exported
variables from one call to the next. So anything that makes the two diverge
without appearing in the command being read — an `export` in an earlier
call, a `~/.curlrc` written earlier (curl reads it unless `-q` comes first,
and the skill's recipes do not pass `-q`), an `HTTPS_PROXY` in the sandbox, a
`curl` earlier on `PATH` — is outside what a `post_tool_call` observer can
detect. Requiring the plugin's own base to be an allowlisted authority closes
the part it can: an `EDGEOS_API_BASE` the agent writes into `$HERMES_HOME/.env`
(Hermes loads it with override at the next start) reaches the plugin too, and
is then not EdgeOS. Within that limit the receipt is bound to one authority:
an action and the read that confirms it are each classified under the same
rule, so both name the allowlisted EdgeOS authority as this process resolves it.

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
UUID_RE = re.compile(_UUID)  # always `fullmatch`: `$` would let a trailing newline through
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
    return re.compile("".join(out) + "/?")  # matched with `fullmatch`


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


#: curl options that change where the request actually goes, whether the host
#: is who it claims to be, or what the request is (`-I` is a HEAD, `--variable`
#: with `--expand-url` builds a URL this parser never sees, `-V` sends nothing).
#: A command using any of them is not read.
_REFUSED_SHORT = frozenset("xKkIhMV")
_REFUSED_LONG = frozenset({
    "--resolve", "--connect-to", "--proxy", "--config", "--insecure", "--socks5", "--socks5-hostname",
    "--preproxy", "--doh-url", "--socks4", "--socks4a", "--proxy1.0", "--proxy-insecure", "--doh-insecure",
    "--unix-socket", "--abstract-unix-socket", "--dns-servers", "--cacert", "--capath",
    "--head", "--variable", "--help", "--manual", "--version",
})
#: `--expand-url`, `--expand-header`, …: a value curl rewrites from `--variable`s.
_REFUSED_LONG_PREFIX = "--expand-"

#: curl options that put something other than the response body on stdout, or
#: the body somewhere else (`-o /dev/null -w '{"id":…}'` prints a record EdgeOS
#: never sent). The call keeps its label; its output is not evidence (`piped`).
_REWRITE_SHORT = frozenset("oOwDiv")
_REWRITE_LONG = frozenset({
    "--output", "--remote-name", "--remote-name-all", "--output-dir", "--write-out", "--dump-header",
    "--include", "--show-headers", "--verbose", "--trace", "--trace-ascii", "--stderr", "--libcurl",
})

#: curl short options that take an argument (`curl --help all`). Everything
#: else in a cluster like `-sSfL` is a flag; `-sXPOST` and `-sX POST` both
#: end the cluster at `X` and take the rest, or the next word, as its value.
_SHORT_WITH_ARG = frozenset("XdHFowuAebcrTmxEKzYyCPQtUD")
_DATA_SHORT = frozenset("dF")
#: Options whose value is a request body. A URL inside a body is content (a
#: `picture_url`, a link in a message), not a place the request goes, so the
#: other-host rule does not read it. `-F` is not among them: `-F x=@file`
#: reads a file, and a form is not what the skill sends.
_BODY_SHORT = frozenset("d")
_BODY_LONG = frozenset({"--data", "--data-raw", "--data-binary", "--json"})
_DATA_LONG = frozenset({
    "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json",
    "--form", "--form-string",
})
_LONG_WITH_ARG = _DATA_LONG | frozenset({
    "--request", "--url", "--header", "--output", "--write-out", "--user", "--user-agent", "--referer",
    "--cookie", "--cookie-jar", "--range", "--max-time", "--connect-timeout", "--retry", "--retry-delay",
    "--retry-max-time", "--cert", "--key", "--upload-file", "--limit-rate", "--max-filesize", "--interface",
    "--oauth2-bearer", "--output-dir", "--dump-header", "--trace", "--trace-ascii", "--stderr", "--libcurl",
    # Refused (`_REFUSED_LONG`), but listed so the argv is read as curl reads
    # it: the refusal, not a miscounted URL, is what keeps them out.
    "--proxy", "--config", "--resolve", "--connect-to", "--cacert", "--capath", "--unix-socket",
    "--abstract-unix-socket", "--dns-servers", "--socks4", "--socks4a", "--socks5", "--socks5-hostname",
    "--proxy1.0", "--preproxy", "--doh-url", "--variable", "--expand-url", "--expand-header", "--expand-data",
})


class HttpCall:
    __slots__ = ("method", "path", "query", "piped")

    def __init__(self, method: str, path: str, query: dict, piped: bool = False) -> None:
        self.method = method
        self.path = path
        self.query = query
        #: The output is not the bare response: it went through `| jq …`, or
        #: a curl option diverted the body or added to stdout. Recognised for
        #: the label, never trusted as a participant record or a confirming read.
        self.piped = piped


DEFAULT_API_BASE = "https://api.edgeos.world/api/v1"

#: The skill's three ways of naming the base (`skills/edgeos/SKILL.md`):
#: `${EDGEOS_API_BASE:-<default>}`, `${EDGEOS_API_BASE}`, `$EDGEOS_API_BASE`.
#: Any other parameter expansion (`:=`, `:+`, `:?`, `-`, `#`, `%`, `!`,
#: nesting) is not one of them, and is refused as any other `$` is.
_BASE_REF = re.compile(r"\$\{EDGEOS_API_BASE(?::-(?P<default>[^}]*))?\}|\$EDGEOS_API_BASE(?![A-Za-z0-9_])")
#: Credentials the agent may name instead of pasting, inside double quotes
#: only (no word splitting there): a header value, never a place.
_CREDENTIAL_REF = re.compile(
    r"\$(?:\{(?:EDGEOS_API_KEY|EDGEOS_BEARER_TOKEN)\}|(?:EDGEOS_API_KEY|EDGEOS_BEARER_TOKEN)(?![A-Za-z0-9_]))")
#: What a base URL may be made of: nothing the shell would expand or split.
_CLEAN_BASE = re.compile(r"[A-Za-z0-9._~:/%-]+")
#: Unquoted, these are brace or pathname expansion: one word can become many.
_EXPANDING = frozenset("{}*?[")
#: Never read: a comment (`#` starts one only at the start of a word, a
#: difference the tokeniser does not model), command substitution, a carriage
#: return (`\<CR><LF>` is an escaped CR and a new line, not a continuation), NUL.
_NEVER = frozenset("#`\r\0")


def _normalised_url(url: str) -> tuple:
    """The URL as this module compares URLs: scheme and host lowercased, the
    path without a trailing `/`."""
    split = urllib.parse.urlsplit(url)
    return split.scheme.lower(), split.netloc.lower(), split.path.rstrip("/") or "/", split.query, split.fragment


def _host_allowed(authority: str, hosts: frozenset) -> bool:
    """`host` or `host:443` on the allowlist; no userinfo."""
    authority = authority.lower()
    if "@" in authority or not authority:
        return False
    host, _, port = authority.partition(":")
    return host in hosts and port in ("", "443")


def _allowed_base(value: str, hosts: frozenset) -> bool:
    """An https URL on an allowlisted EdgeOS authority, with nothing a shell
    would expand or split and no query or fragment."""
    if not _CLEAN_BASE.fullmatch(value):
        return False
    split = urllib.parse.urlsplit(value)
    return (split.scheme.lower() == "https" and _host_allowed(split.netloc, hosts)
            and not split.query and not split.fragment)


def _base_value(default: Optional[str], hosts: frozenset) -> Optional[str]:
    """What the base reference expands to, as far as this process can know.

    The plugin reads `EDGEOS_API_BASE` from its own environment; the shell
    reads the terminal's, which starts from the same one. A divergence
    between them is outside what an observer can see (module docstring).
    Given that, the reference is read only when the value it yields is an allowed
    EdgeOS base: the plugin's own value when set and non-empty, else (for the
    `:-` form only) the default as written, which must be the plugin's default.
    `$EDGEOS_API_BASE` with the variable unset yields an empty string, which
    names no host: not read.
    """
    if default is not None and not (_CLEAN_BASE.fullmatch(default)
                                    and _normalised_url(default) == _normalised_url(DEFAULT_API_BASE)):
        return None
    value = os.environ.get("EDGEOS_API_BASE")
    if not value:  # `:-` substitutes the default for unset and for empty alike
        if default is None:
            return None
        value = default  # as written: the shell sends these exact characters
    return value if _allowed_base(value, hosts) else None


def _shell_words(command: str, hosts: frozenset) -> Optional[str]:
    """The command as the shell would hand it to word splitting, or None.

    Performs the two things the shell does here that `shlex` does not: a
    backslash-newline outside single quotes is removed outright (joined with
    nothing), and the skill's base reference is expanded (`_base_value`).
    Refuses everything else that would make the shell's words differ from the
    tokeniser's: any other `$` outside single quotes (variables, `$'…'`,
    `$"…"`, other parameter expansions), unquoted brace or glob characters,
    the `_NEVER` characters, an unclosed quote or a trailing backslash.
    """
    if any(c in _NEVER for c in command) or "$(" in command:
        return None
    out: list[str] = []
    quote = ""
    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if quote == "'":
            out.append(c)
            quote = "" if c == "'" else quote
            i += 1
            continue
        if c == "\\":
            if i + 1 >= n:
                return None
            following = command[i + 1]
            if following == "\n":
                pass  # a line continuation: removed
            elif quote == '"' and following == "$":
                out.append("$")  # `\$` inside double quotes is a literal `$`
            else:
                out.append(command[i:i + 2])  # the tokeniser applies the same escape
            i += 2
            continue
        if c == "$":
            base = _BASE_REF.match(command, i)
            if base is not None:
                value = _base_value(base.group("default"), hosts)
                if value is None:
                    return None
                out.append(value)
                i = base.end()
                continue
            credential = _CREDENTIAL_REF.match(command, i)
            if credential is not None and quote == '"':
                out.append(credential.group(0))
                i = credential.end()
                continue
            return None
        if quote == '"':
            quote = "" if c == '"' else quote
        elif c in "'\"":
            quote = c
        elif c in _EXPANDING:
            return None
        out.append(c)
        i += 1
    if quote:
        return None
    return "".join(out)


def _tokens(command: str) -> Optional[list[str]]:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=_PUNCTUATION)
        lexer.whitespace = " \t"  # a newline separates commands: an operator, not a space
        lexer.whitespace_split = True
        lexer.commenters = ""  # `#` never reaches here (`_NEVER`)
        return list(lexer)
    except ValueError:
        return None


_STDERR_TO_STDOUT = "2>&1"


def _curl_segment(tokens: list[str]) -> Optional[tuple[list[str], list[str]]]:
    """(curl's arguments, whatever follows them), or None.

    None unless the command *is* the curl: its first word is `curl` — not a
    path to some other program called curl, and nothing before it (no `cd`,
    no assignment, no `export`, no other command, no here-document): anything
    earlier can decide whether the curl runs at all, or where it goes — and
    there is no other `curl` word. The arguments end at the first control
    operator or `2>&1`; the rest is the tail, which `_read_tail_ok` judges.
    """
    if not tokens or tokens[0] != "curl":
        return None
    if any(t == "curl" or t.endswith("/curl") for t in tokens[1:]):
        return None
    rest: list[str] = []
    i = 1
    while i < len(tokens):
        if tokens[i:i + 3] == ["2", ">&", "1"]:
            rest.append(_STDERR_TO_STDOUT)
            i += 3
            continue
        rest.append(tokens[i])
        i += 1
    for index, token in enumerate(rest):
        if token == _STDERR_TO_STDOUT or _is_operator(token):
            return rest[:index], rest[index:]
    return rest, []


def _is_newlines(token: str) -> bool:
    return bool(token) and set(token) == {"\n"}


def _read_tail_ok(tail: list[str]) -> tuple[bool, bool]:
    """(acceptable, piped) for what follows a *read*: optionally `2>&1`, then
    optionally `| jq …` (arguments only, no further operator), then only
    trailing newlines. A write accepts no tail at all: a pipe, `;`, `&&`,
    `||`, a redirect or a new line after it could run a second request, or
    rewrite what the agent saw as the response."""
    i, piped = 0, False
    if i < len(tail) and tail[i] == _STDERR_TO_STDOUT:
        i += 1
    if i < len(tail) and tail[i] == "|":
        if i + 1 >= len(tail) or tail[i + 1] != "jq":
            return False, False
        piped = True
        i += 2
        while i < len(tail) and not _is_operator(tail[i]) and tail[i] != _STDERR_TO_STDOUT:
            i += 1
    while i < len(tail) and _is_newlines(tail[i]):
        i += 1
    return i == len(tail), piped


def _parse_curl(args: list[str]) -> Optional[tuple[str, list[str], set, bool]]:
    """(METHOD, [url arguments], {positions in `args` holding a request body},
    output rewritten), or None if the argv cannot be read as curl reads it."""
    method_x: Optional[str] = None
    get = data = upload = rewritten = False
    urls: list[str] = []
    bodies: set = set()
    i = 0
    while i < len(args):
        token = args[i]
        i += 1
        if token == "--":
            urls.extend(args[i:])
            break
        if token.startswith("--"):
            # curl has no `--name=value` form: `--request=POST` is an unknown
            # option, and curl sends nothing.
            if "=" in token or token in _REFUSED_LONG or token.startswith(_REFUSED_LONG_PREFIX):
                return None
            name, value = token, ""
            if name in _LONG_WITH_ARG:
                if i >= len(args):
                    return None
                value = args[i]
                if name in _BODY_LONG:
                    bodies.add(i)
                i += 1
            if name in _REWRITE_LONG:
                rewritten = True
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
                if flag in _REWRITE_SHORT:
                    rewritten = True
                if flag in _SHORT_WITH_ARG:
                    value = token[j + 1:]
                    if not value:
                        if i >= len(args):
                            return None
                        value = args[i]
                        if flag in _BODY_SHORT:
                            bodies.add(i)
                        i += 1
                    elif flag in _BODY_SHORT:
                        bodies.add(i - 1)  # `-d{…}`: the value is in this token
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
    if get and data:
        # `-G` moves the data into the query string: the URL curl requests is
        # not the URL argument, and its query may name another occurrence.
        return None
    if method_x is not None:  # -X wins over everything, as it does in curl
        # curl sends the method exactly as written (`-X post` is `post`).
        if method_x not in _METHODS:
            return None
        method = method_x
    elif get:
        method = "GET"
    elif upload:
        method = "PUT"
    elif data:
        method = "POST"
    else:
        method = "GET"
    return method, urls, bodies, rewritten


def _printable(text: str) -> bool:
    return all(0x20 < ord(c) < 0x7F or ord(c) > 0x9F for c in text)


def http_call(tool_name: Any, args: Any, allowlist: Allowlist = ALLOWLIST) -> Optional[HttpCall]:
    """The one EdgeOS request a carrier tool call makes, or None.

    None whenever it is ambiguous or foreign: not a carrier tool; the command
    is not one `curl` and nothing else (anything before it, or any other
    `curl` word); a shell form the tokeniser does not reproduce
    (`_shell_words`); any http(s) URL in the command on a host other than
    EdgeOS (or on a port other than 443); not exactly one URL argument, or
    one with whitespace or a control character; two different EdgeOS paths
    anywhere in the command, headers included; a curl option that moves the
    request or changes what it is. An unrecognised call only loses a label;
    a misread one would invent an RSVP.
    """
    if not isinstance(tool_name, str) or tool_name not in allowlist.carriers or not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) or not command or len(command) > MAX_COMMAND_CHARS:
        return None
    # Line continuations are joined and the skill's base reference expanded,
    # as the shell would (the skill's recipes are written that way,
    # `skills/edgeos/SKILL.md` §6). Leading and trailing whitespace (a final
    # newline) runs nothing.
    words = _shell_words(command, allowlist.hosts)
    if words is None:
        return None
    tokens = _tokens(words.strip(" \t\n"))
    if tokens is None:
        return None
    found = _curl_segment(tokens)
    if found is None:
        return None
    segment, tail = found
    parsed = _parse_curl(segment)
    if parsed is None:
        return None
    method, urls, bodies, rewritten = parsed
    # Every word of the command that is not a request body: request targets,
    # headers, other options, anything after the curl.
    others = [t for i, t in enumerate(tokens) if i - 1 not in bodies]
    authorities = [m.group(1) for word in others for m in _ANY_URL.finditer(word)]
    if not authorities or not all(_host_allowed(a, allowlist.hosts) for a in authorities):
        return None
    if len(urls) != 1 or not _printable(urls[0]):
        return None
    piped = False
    if tail:
        if method != "GET":
            return None
        acceptable, piped = _read_tail_ok(tail)
        if not acceptable:
            return None
    split = urllib.parse.urlsplit(urls[0])
    if split.scheme.lower() not in ("http", "https") or not _host_allowed(split.netloc, allowlist.hosts):
        return None
    path = split.path.rstrip("/") or "/"
    # Every EdgeOS URL in the command must name this path: one in a header
    # (`-H "Referer: …"`) that names another is a second request in disguise.
    for word in others:
        for match in re.finditer(r"https?://[^/\s'\"`<>|;&()\\]*(/[^\s'\"`?#<>|;&()\\]*)", word, re.IGNORECASE):
            if (match.group(1).rstrip("/") or "/") != path:
                return None
    return HttpCall(method, path, parse_query(split.query), piped or rewritten)


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
        found = op.pattern.fullmatch(call.path)
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
    if not (isinstance(participant, str) and UUID_RE.fullmatch(participant)):
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
        if not (isinstance(event_id, str) and UUID_RE.fullmatch(event_id)) or not (status is None or isinstance(status, str)):
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
        and isinstance(participant, str) and UUID_RE.fullmatch(participant) is not None
    )


def _valid_last(value: Any) -> bool:
    return isinstance(value, dict) and all(k in CONFIRMS and valid_id(v) for k, v in value.items())


def _valid_key(key: Any) -> bool:
    if not isinstance(key, str) or "|" not in key:
        return False
    event_id, _, occurrence = key.partition("|")
    return UUID_RE.fullmatch(event_id) is not None and (occurrence == "" or iso_from_text(occurrence) == occurrence)


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
        # Output that is not the bare response (`HttpCall.piped`) is not
        # EdgeOS's answer, so it carries no participant record.
        trusted = ok and exit_code in (None, 0) and not call.piped
        record = participant_record(body, event_id) if trusted else None
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

    if not ok or exit_code not in (None, 0) or call.piped:
        # A read whose output went through `jq` is what the agent made of the
        # response, not the response: it confirms nothing.
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
