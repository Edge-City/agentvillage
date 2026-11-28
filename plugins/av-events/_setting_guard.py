"""POST-VILLAGE SETTING GUARD (A79, review-b ov#632 S1): the agent cannot change the operator's setting.

After 2026-11-01T18:30Z nine kinds of scheduled work run only when `$HERMES_HOME/av-events/post-village-policy.json`
allows them (skills/index-network/scripts/post-village-policy.ts). The file sits in the agent's own home under its
own user, so a resident's ask or injected text could lead the agent to write the allow list. This module returns a
`block` directive, before the tool runs, for every agent tool call that would change that file. Its message says the
setting is the operator's and the person should contact the Agent Village team (REFUSAL).

What is refused (the call's own text decides; nothing is read from disk):

1. `write_file`, `patch` (replace and V4A), `skill_manage`, `cronjob_manage`: any string argument that names the
   setting (NAMES: `post-village-policy`, so the file in any case, its temp files and the TypeScript reader too, or
   `post_village_policy`: the operator command and the pinned Python reader), or a `path`/`file_path` whose last
   part is the `av-events` folder.
2. `execute_code` (its `code`): NAMES or any FRAGMENT (`av-events`, `post-village`, `village-policy`, `policy.json`,
   ...). Code can build a name from pieces, so any piece of it is enough (AGENTS.md already says never to write
   under $HERMES_HOME from code).
3. `terminal` (`command`, with `workdir` read as a `cd` before it) and `process_manage` write/submit (`data`):
   a. a command that names the setting (NAMES, or a glob word that could match its basename in `av-events` or in a
      folder this cannot know: `av-events/*.json`, `post-village-*`, `p*` after a `cd`) is refused unless it is
      provably read-only: every simple command is one of READ_ONLY (`find` without an action flag) or the operator
      command's status (`bun [run] <...>/post_village_policy.ts status [--home X]`), with no variable assignment,
      no write redirect (only to /dev/null or a descriptor), no heredoc and no OPAQUE_SYNTAX;
   b. a command that is not read-only and takes the `av-events` folder itself as an argument (a rename, removal,
      symlink, copy onto or re-permission of the folder), or a MUTATING command that takes the Hermes home itself;
   c. a command that holds an opaque construct (OPAQUE_SYNTAX: $(...), backticks, <(...), $'...', an escape, a
      variable other than $HOME and $HERMES_HOME; or a simple command run by one of OPAQUE_COMMANDS: eval,
      xargs, a shell, an interpreter, a decoder, tr, printf, curl, ...; or `find` with an action flag) together
      with any FRAGMENT: the name could be built where this cannot read it.
   A bare glob (no folder) in a command that is not read-only is judged as if the shell sat in `av-events`, since
   the shell's folder is not known here: `rm *.json` or `cp * /x` is refused wherever it runs.

Not caught (a same-user guard against instruction-following, not an operating-system boundary): a name built from
pieces none of which is a FRAGMENT, in code or across calls (shell variables or files kept from an earlier call);
a script written earlier without naming the file (a file tool's content is checked when written) and run later,
by the terminal or as a no-agent cron script; an archive or tree copied into the home by a relative name after a
`cd`; a renamed ancestor of the Hermes home; the installed scripts that call the readers, config.yaml or this
plugin edited (then a restart); and anything run outside Hermes's tool dispatch (an operator's shell is not hooked).

No switch: an off switch would be an `.env` line the agent itself could write. Never raises: if the matcher fails,
a call whose text holds a FRAGMENT or NAMES is refused and any other passes (one warning, no text). No log carries
text.
"""

from __future__ import annotations

import fnmatch
import logging
import os
import re
import shlex
from typing import Any, Iterator, List, Mapping, Optional

from ._edgeos_guard import normalised

logger = logging.getLogger("av-events")

SETTING_NAME = "post-village-policy.json"
SETTING_DIR = "av-events"
REFUSAL = ("Refused by Agent Village: this would change av-events/post-village-policy.json, the setting that turns "
           "scheduled jobs on or off. That setting belongs to the operator and you cannot change it. If the person "
           "wants a scheduled job back on, tell them to contact the Agent Village team.")

#: The setting by name: the file, its temp files and its TypeScript reader; the operator command and the
#: Python reader (`install/post_village_policy.ts`, `plugins/village-bridge/_post_village_policy.py`).
_NAMES = re.compile(r"post-village-policy|post_village_policy")
#: Pieces of the name and its folder. With an opaque construct (or in code) any one is enough.
FRAGMENTS = ("av-events", "av_events", "post-village", "post_village", "postvillage", "village-policy",
             "village_policy", "policy.json")
#: The tools whose string arguments (any depth) are checked for NAMES, and their path fields.
ARG_TOOLS = frozenset({"write_file", "patch", "skill_manage", "cronjob_manage"})
PATH_FIELDS = ("path", "file_path")
#: Commands that read and never write. `cd` and `pwd` change nothing on disk.
READ_ONLY = frozenset({"cat", "ls", "stat", "sha256sum", "shasum", "md5sum", "head", "tail", "wc", "file", "jq",
                       "grep", "egrep", "fgrep", "rg", "diff", "cmp", "readlink", "realpath", "test", "[", "cd",
                       "pwd", "find", "echo"})
FIND_ACTIONS = frozenset({"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"})
#: Commands that move, copy onto, remove, link or re-permission their arguments (rule 3b, the Hermes home).
MUTATING = frozenset({"mv", "cp", "rm", "rmdir", "ln", "rsync", "install", "unlink", "shred", "chmod", "chown",
                      "chgrp", "chattr", "setfacl", "tar", "unzip", "cpio", "rename", "mount", "find"})
#: The Hermes home as a whole argument, lower-cased. The real `$HERMES_HOME` is added per call, and `~`,
#: `$HOME` too when `$HOME` is the Hermes home.
HOME_WORDS = frozenset({"$hermes_home", "${hermes_home}", "~/.hermes", "$home/.hermes", "${home}/.hermes", "/opt/data"})
#: Opaque syntax: the name or the content may be made where the text does not show it.
OPAQUE_SYNTAX = re.compile(r"\$\(|`|<\(|>\(|\$'|\$\"|\\[0-7xuU]"
                           r"|\$\{?(?!(?:HERMES_HOME|HOME)(?![A-Za-z0-9_]))[A-Za-z_0-9@*#?!$-]", re.IGNORECASE)
#: Commands (at a command's position) that run other text, run another command, decode or transform text, or
#: take a name from elsewhere; `python*` and `find` with an action flag count too.
OPAQUE_COMMANDS = frozenset({
    "eval", "exec", "source", ".", "xargs", "env", "command", "builtin", "sudo", "su", "nohup", "setsid", "timeout",
    "nice", "ionice", "stdbuf", "time", "watch", "flock", "chroot", "unshare", "busybox", "parallel", "script",
    "expect", "base64", "base32", "basenc", "xxd", "od", "openssl", "uudecode", "gzip", "gunzip", "zcat", "bzip2",
    "xz", "tar", "unzip", "cpio", "tr", "rev", "printf", "sed", "awk", "gawk", "mawk", "nawk", "perl", "ruby", "php",
    "lua", "tclsh", "node", "nodejs", "bun", "bunx", "deno", "npx", "sh", "bash", "zsh", "dash", "ksh", "fish",
    "csh", "tcsh", "sqlite3", "curl", "wget"})
_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")
_WORD_SPLIT = re.compile(r"[\s;&|()<>`=]+")
_GLOB_CHARS = frozenset("*?[{")
_CONTROL = frozenset(";&|()")
_MAX_BRACES = 64


def flat(text: str) -> str:
    """The text as this guard matches it: continuations joined and quotes dropped (the EdgeOS guard's
    `normalised`), backslashes dropped, lower case."""
    return normalised(text).replace("\\", "").lower()


def _strings(value: Any, depth: int = 0) -> Iterator[str]:
    if depth > 8:
        return
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item, depth + 1)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item, depth + 1)


def _has_fragment(text: str) -> bool:
    return any(piece in text for piece in FRAGMENTS)


def _expand_braces(word: str) -> List[str]:
    """Bash brace expansion of `{a,b}` groups (nested ones too), at most _MAX_BRACES words; a group with no
    top-level comma stays as it is."""
    done, todo = [], [word]
    while todo and len(done) + len(todo) <= _MAX_BRACES:
        current = todo.pop()
        found = None
        depth = start = 0
        for i, ch in enumerate(current):
            if ch == "{":
                start = i if depth == 0 else start
                depth += 1
            elif ch == "}" and depth:
                depth -= 1
                if depth:
                    continue
                inner, parts, level, last = current[start + 1:i], [], 0, 0
                for j, c in enumerate(inner):
                    level += (c == "{") - (c == "}")
                    if c == "," and level == 0:
                        parts.append(inner[last:j])
                        last = j + 1
                if parts:
                    found = (start, i, parts + [inner[last:]])
                    break
        if found is None:
            done.append(current)
        else:
            start, end, parts = found
            todo.extend(current[:start] + part + current[end + 1:] for part in parts)
    return done + todo


def _could_match(pattern: str, name: str) -> bool:
    return any(fnmatch.fnmatchcase(name, p) for p in _expand_braces(pattern))


def _unknown_dir(part: str) -> bool:
    """A folder part that could be `av-events`: `.`, `..`, `**`, a variable other than the homes, or a glob."""
    if part in ("$hermes_home", "${hermes_home}", "$home", "${home}", "~"):
        return False
    if part in (".", "..", "**") or "$" in part:
        return True
    return bool(_GLOB_CHARS & set(part)) and _could_match(part, SETTING_DIR)


def _glob_names_setting(word: str) -> bool:
    """A glob word that could match the setting's basename in `av-events` or in a folder this cannot know."""
    if not _GLOB_CHARS & set(word):
        return False
    parts = word.split("/")
    if not parts[-1] or not _could_match(parts[-1], SETTING_NAME):
        return False
    if len(parts) == 1 or "**" in parts:
        return True
    return parts[-2] == SETTING_DIR or _unknown_dir(parts[-2])


def names_setting(text: str) -> bool:
    """The flattened text names the setting: NAMES, or a glob word that could match it."""
    return bool(_NAMES.search(text)) or any(_glob_names_setting(word) for word in _WORD_SPLIT.split(text) if word)


def _segments(command: str) -> List[List[str]]:
    """The simple commands of `command` as shlex words (quotes honoured), split at ; & | ( ) and line breaks.
    Raises ValueError on text shlex cannot read (an unbalanced quote)."""
    text = command.replace("\\\r\n", " ").replace("\\\n", " ").replace("\r\n", "\n").replace("\n", " ; ")
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    segments: List[List[str]] = [[]]
    for token in lexer:
        if token and set(token) <= _CONTROL:
            segments.append([])
        else:
            segments[-1].append(token)
    return [segment for segment in segments if segment]


def _words(segment: List[str]) -> Optional[List[str]]:
    """A simple command's words without its redirections, or None when it writes through one (anything but
    /dev/null or a descriptor copy) or reads a heredoc or here-string."""
    words, skip = [], False
    for i, token in enumerate(segment):
        if skip:
            skip = False
        elif token.startswith("<<"):
            return None
        elif ">" in token:
            target = segment[i + 1] if i + 1 < len(segment) else ""
            if not (target == "/dev/null" or (token.endswith("&") and (target.isdigit() or target == "-"))):
                return None
            skip = True
        elif token != "<":
            words.append(token)
    return words


def _split_command(words: List[str]) -> tuple:
    """(command name, its arguments): leading assignments skipped; an assignment-only command has no name and
    its assignments for arguments."""
    i = 0
    while i < len(words) and _ASSIGN.match(words[i]):
        i += 1
    if i == len(words):
        return "", words
    return words[i].rsplit("/", 1)[-1].lower(), words[:i] + words[i + 1:]


def _operator_status(words: List[str]) -> bool:
    """`bun [run] <...>/post_village_policy.ts status [--home X]`: the operator command's read."""
    name, rest = _split_command(words)
    if name != "bun" or len(rest) != len(words) - 1:
        return False
    if rest and rest[0] == "run":
        rest = rest[1:]
    if len(rest) < 2 or rest[0].rsplit("/", 1)[-1] != "post_village_policy.ts" or rest[1] != "status":
        return False
    return rest[2:] == [] or (len(rest) == 4 and rest[2] == "--home")


def _reads_only(name: str, args: List[str]) -> bool:
    return name in READ_ONLY and not (name == "find" and FIND_ACTIONS & set(args))


def read_only(command: str) -> bool:
    """Every simple command reads only (READ_ONLY, or the operator command's status), with no assignment, no
    write redirect, no heredoc and no OPAQUE_SYNTAX. Text shlex cannot read is not read-only."""
    if OPAQUE_SYNTAX.search(command):
        return False
    try:
        segments = _segments(command)
    except ValueError:
        return False
    for segment in segments:
        words = _words(segment)
        if words is None:
            return False
        if not words:
            continue
        if _ASSIGN.match(words[0]):
            return False
        if not (_operator_status(words) or _reads_only(*_split_command(words))):
            return False
    return True


def _home_words(environ: Mapping[str, str]) -> frozenset:
    home = str(environ.get("HERMES_HOME", "") or "").strip().rstrip("/").lower()
    user = str(environ.get("HOME", "") or "").strip().rstrip("/").lower()
    extra = {home} if home else set()
    if home and user == home:
        extra |= {"~", "$home", "${home}"}
    return HOME_WORDS | extra


def _as_path(word: str) -> str:
    """An argument as a path: the value after a `--flag=`, `of=` or `NAME=`, lower case, without a trailing
    `/` or `/.`."""
    value = word.rsplit("=", 1)[-1].lower()
    while len(value) > 1 and (value.endswith("/") or value.endswith("/.")):
        value = value[:-1] if value.endswith("/") else value[:-2]
    return value


def _could_be_home(parent: str, homes: frozenset) -> bool:
    """A folder that could be the Hermes home: one of `homes`, a `.hermes`, or a last part this cannot know
    (`.`, `..`, `**`, a variable other than the homes, a glob that could match the home's own name)."""
    if parent in homes or parent.rsplit("/", 1)[-1] == ".hermes":
        return True
    part = parent.rsplit("/", 1)[-1]
    if part in (".", "..", "**") or ("$" in part and part not in ("$hermes_home", "${hermes_home}", "$home", "${home}")):
        return True
    names = {home.rsplit("/", 1)[-1] for home in homes if "/" in home} | {".hermes"}
    return bool(_GLOB_CHARS & set(part)) and any(_could_match(part, name) for name in names if name)


def _names_folder(path: str, homes: frozenset) -> bool:
    """`path` is the `av-events` folder itself, or a glob for it in a folder that could be the Hermes home (a
    bare glob: the shell's folder is not known here)."""
    parent, _, last = path.rpartition("/")
    if last == SETTING_DIR:
        return True
    if not (_GLOB_CHARS & set(last) and _could_match(last, SETTING_DIR)):
        return False
    return "/" not in path or _could_be_home(parent, homes)


def _swaps_folder(command: str, environ: Mapping[str, str]) -> bool:
    """Rule 3b: a command that is not read-only takes `av-events` itself as an argument, or a MUTATING command
    takes the Hermes home itself. Text shlex cannot read counts when it holds a FRAGMENT."""
    try:
        segments = _segments(command)
    except ValueError:
        return _has_fragment(flat(command))
    homes = _home_words(environ)
    for segment in segments:
        words = [token for token in segment if ">" not in token and token != "<"]
        if not words:
            continue
        name, args = _split_command(words)
        if _reads_only(name, args):
            continue
        for word in args:
            path = _as_path(word)
            if _names_folder(path, homes):
                return True
            if name in MUTATING and (path in homes or path.rsplit("/", 1)[-1] == ".hermes"):
                return True
    return False


def _opaque(command: str) -> bool:
    """OPAQUE_SYNTAX anywhere, or an OPAQUE_COMMANDS command (python*, find with an action flag) in any simple
    command. Text shlex cannot read is opaque."""
    if OPAQUE_SYNTAX.search(command) or OPAQUE_SYNTAX.search(flat(command)):
        return True
    try:
        segments = _segments(command)
    except ValueError:
        return True
    for segment in segments:
        name, args = _split_command([token for token in segment if ">" not in token and token != "<"])
        if name in OPAQUE_COMMANDS or name.startswith("python") or (name == "find" and FIND_ACTIONS & set(args)):
            return True
    return False


def _terminal_refuses(command: str, environ: Mapping[str, str]) -> bool:
    text = flat(command)
    if names_setting(text):
        return not read_only(command)
    if _swaps_folder(command, environ):
        return True
    return _has_fragment(text) and _opaque(command)


def _command_text(tool_name: str, args: dict) -> Optional[str]:
    """What a terminal-like call runs: `terminal`'s command (its `workdir` as a `cd` before it), or
    `process_manage`'s write/submit data (what a background shell reads as a command)."""
    if tool_name == "terminal":
        command = args.get("command")
        if not isinstance(command, str):
            return None
        workdir = args.get("workdir")
        return f"cd {shlex.quote(workdir)} ; {command}" if isinstance(workdir, str) and workdir else command
    if tool_name == "process_manage" and args.get("action") in ("write", "submit"):
        data = args.get("data")
        return data if isinstance(data, str) else None
    return None


def matches(tool_name: Any, args: Any, environ: Optional[Mapping[str, str]] = None) -> bool:
    """The rules in the module docstring. May raise on odd input; `safe_directive` handles that."""
    if not isinstance(tool_name, str) or not isinstance(args, dict):
        return False
    environ = os.environ if environ is None else environ
    if tool_name in ARG_TOOLS:
        if any(_NAMES.search(flat(text)) for text in _strings(args)):
            return True
        return any(isinstance(args.get(field), str) and _as_path(args[field]).rsplit("/", 1)[-1] == SETTING_DIR
                   for field in PATH_FIELDS)
    if tool_name == "execute_code":
        code = args.get("code")
        return isinstance(code, str) and (_has_fragment(flat(code)) or bool(_NAMES.search(flat(code))))
    command = _command_text(tool_name, args)
    return command is not None and _terminal_refuses(command, environ)


def safe_directive(tool_name: Any, args: Any, environ: Optional[Mapping[str, str]] = None,
                   matcher=None) -> Optional[dict]:
    """The block directive for a matching call, else None. Never raises: if the matcher fails, the call is
    refused when any string argument holds a FRAGMENT or NAMES, else allowed with one warning (no text).
    No switch turns it off. `matcher` is for tests."""
    try:
        hit = (matcher or matches)(tool_name, args, environ)
        return {"action": "block", "message": REFUSAL} if hit else None
    except BaseException:  # noqa: BLE001 - a raise here would block every tool call
        try:
            if isinstance(args, dict) and any(_has_fragment(text.lower()) or _NAMES.search(text.lower())
                                              for text in _strings(args)):
                return {"action": "block", "message": REFUSAL}
        except BaseException:  # noqa: BLE001
            pass
        try:
            logger.warning("av-events: setting_guard matcher failed; call allowed")
        except BaseException:  # noqa: BLE001
            pass
        return None


__all__ = ["SETTING_NAME", "SETTING_DIR", "REFUSAL", "FRAGMENTS", "READ_ONLY", "flat", "names_setting", "read_only",
           "matches", "safe_directive"]
