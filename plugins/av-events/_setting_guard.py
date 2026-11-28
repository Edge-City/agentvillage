"""POST-VILLAGE SETTING GUARD (A79, review-b ov#632 S1, ov#633 M1 M2 S1): the agent cannot change the operator's
setting, switch on a job it keeps off, or edit the code that enforces it.

After 2026-11-01T18:30Z nine kinds of scheduled work run only when `$HERMES_HOME/av-events/post-village-policy.json`
allows them (skills/index-network/scripts/post-village-policy.ts). The file, this plugin, the scripts that check the
file and the cron store all sit in the agent's own home under its own user, so a resident's ask or injected text
could lead the agent to rewrite any of them. This module returns a `block` directive, before the tool runs, for
such a call. Its message (REFUSAL) says the call touches the operator's setting, a job it keeps off or the code that
enforces it, and that the person should contact the Agent Village team.

What is refused (the call's own text decides; the disk is read only for a cron job's name, the setting through the
runner's pinned reader, and config.yaml for a patch of it):

1. `write_file`, `patch` (replace and V4A), `skill_manage`, `cronjob_manage`: any string argument that names the
   setting (NAMES: `post-village-policy`, so the file in any case, its temp files and the TypeScript reader too, or
   `post_village_policy`: the operator command and the pinned Python reader), or a `path`/`file_path` whose last
   part is the `av-events` folder.
2. `execute_code` (its `code`): a piece of the file's own name, of the operator command or of the readers
   (CODE_PIECES: `post-village`, `post_village`, `village-policy`, ...); never `av-events` or `policy.json` alone.
3. `terminal` (`command`, with `workdir` read as a `cd` before it) and `process_manage` write/submit (`data`):
   a. a command that names the setting (NAMES, or a glob word that could match its basename where the command
      itself puts it: a parent part that is or could be `av-events`, a `**` below the Hermes home or an ancestor,
      or a relative glob after a `cd`/`pushd` or `workdir` into `av-events`; or a glob for a policy script whose
      literal part carries `post`, `vill` or `polic`) is refused unless it is provably read-only: every simple
      command is one of READ_ONLY (`find` without an action flag) or the operator command's status
      (`bun [run] <...>/post_village_policy.ts status [--home X]`), with no variable assignment, no heredoc, no
      OPAQUE_SYNTAX, and no write redirect except to a literal file outside `av-events` (or /dev/null, or a
      descriptor);
   b. a command that is not read-only and takes the `av-events` folder itself as an argument (or a glob for it in
      the Hermes home, a bare one only after a `cd`/`pushd` or `workdir` into the home), a MUTATING command that
      takes the Hermes home itself, or a `find` with an action flag whose -name/-path pattern could match the
      setting and either holds a piece of its name or starts where it reaches it (the home, an ancestor,
      `av-events`, or `.` after a `cd` into one);
   c. a command that holds an opaque construct (OPAQUE_SYNTAX: $(...), backticks, <(...), $'...', an escape, a
      variable other than $HOME and $HERMES_HOME; or a simple command run by one of OPAQUE_COMMANDS: eval,
      xargs, a shell, an interpreter, a decoder, tr, printf, curl, ...; or `find` with an action flag) together
      with any FRAGMENT: the name could be built where this cannot read it.
   A bare glob with no placement in the command (`rm *.json`, `cp * /x`, `git add *`) passes: the shell's folder
   left by an earlier call is not known here.
4. The code that enforces the setting (M1, M2), in every checked tool: a write (a file tool's path or V4A file
   line, a redirect target, an argument a command writes: WRITE_ALL, WRITE_LAST's last or `-t`, `dd of=`, an
   in-place sed/perl/awk, find with an action) into a CODE_DIRS folder (`plugins/av-events`, `plugins/village-bridge`,
   `skills/index-network/scripts`, `skills/zzzbot/scripts`), onto an installer's script in `scripts/` by name
   (SCRIPT_NAMES, `agentvillage_*`; a glob for one in a `scripts` folder), or onto a CODE_PARENTS folder of the
   home (`plugins`, `skills`, `scripts`, ...); a text (file content, code, inline interpreter code) that names that
   code (CODE_NAME_PIECES); an overlay skill's scripts by `skill_manage`; HERMES_SAFE_MODE; config.yaml of the home
   when its new text would not load av-events (a whole-file write must list it in `plugins.enabled` and not in
   `plugins.disabled`; a patch is applied to the real file and checked; a V4A patch, a terminal replace, or a
   terminal edit mentioning CONFIG_WORDS is refused); `hermes plugins disable|remove|rm|uninstall|update` of
   av-events or av_events; `hermes config` with CONFIG_WORDS.
5. The cron store (M2): `cronjob_manage` resume, enable, update, edit, run, run_now or trigger (and `hermes cron
   resume|run|edit|...`) of a covered job (COVERED_JOBS, by name in any case, or by id looked up read-only in
   `$HERMES_HOME/cron/jobs.json`), or a create with a covered name, is refused unless the setting allows the job's
   key, read by the runner's own pinned reader (POLICY_READER_SHA256). A store or reader that cannot be read
   refuses. A pause, a removal, and any job that is not covered pass.
6. The allow list itself (S1), whatever carries it: `--enabled`, or `"enabled": [`, with a policy key.
Every path is folded first (`.` and `..` parts, posixpath.normpath; in code and file text too), and a relative
path whose folder no `cd` in the same command made known counts from the Hermes home, where the terminal starts. A
command that reads the setting is still put through rules 4 and 5, and a redirect onto guarded code or config is
never a safe one. The `hermes cron` rule checks EVERY word after the verb (and each `--opt=value` value), not the one
a parser would pick; a `cronjob_manage` job_id may be a list, and an update's `name` is checked too.

Not caught (a same-user guard against instruction-following, not an operating-system boundary; a multi-step
evasion by a model that has read this guard is not stopped by any name list): a name built from pieces none of
which is a FRAGMENT (in code: none of which is a CODE_PIECE or CODE_NAME_PIECE), or across calls (shell variables,
files, symlinks or a `cd` kept from an earlier call, then a bare glob); a script written earlier without naming
what it edits, run later by the terminal or as a no-agent cron script; an archive or tree copied into the home by
a relative name after a `cd`; a renamed ancestor of the Hermes home; a symlink (text cannot see one); any
installed script that is not on the lists above; text to speech, image and video outputs and browser downloads (their paths are not read); and anything run
outside Hermes's tool dispatch (an operator's shell, the installer, are not hooked).

No switch: an off switch would be an `.env` line the agent itself could write. Never raises (Hermes blocks every
call whose `pre_tool_call` callback raises): if the matcher fails, a call whose text holds a piece of the guarded
names is refused and any other passes (one warning, no text). No log carries text.
"""

from __future__ import annotations

import contextvars
import fnmatch
import functools
import logging
import os
import re
import posixpath
import shlex
from typing import Any, Iterator, List, Mapping, Optional

from ._edgeos_guard import normalised

logger = logging.getLogger("av-events")

SETTING_NAME = "post-village-policy.json"
SETTING_DIR = "av-events"
#: One message for every refusal, true for a refused read too (review-b ov#633 N4).
REFUSAL = ("Refused by Agent Village: this call touches the operator's post-village setting, a scheduled job it "
           "keeps off, or the code that enforces it. You cannot change those. If the person wants a scheduled job "
           "back on, tell them to contact the Agent Village team.")

#: The setting by name: the file, its temp files and its TypeScript reader; the operator command and the
#: Python reader (`install/post_village_policy.ts`, `plugins/village-bridge/_post_village_policy.py`).
_NAMES = re.compile(r"post-village-policy|post_village_policy")
#: Pieces of the name and its folder. With an opaque construct (or in code) any one is enough.
FRAGMENTS = ("av-events", "av_events", "post-village", "post_village", "postvillage", "village-policy",
             "village_policy", "policy.json")
#: What refuses `execute_code`: pieces of the file's own name, of the operator command and of the readers only
#: (never `av-events` or `policy.json` alone: other files live in av-events and other policies exist).
CODE_PIECES = ("post-village-polic", "post_village_polic", "post-village", "post_village", "postvillage",
               "village-policy", "village_policy")
#: The tools whose string arguments (any depth) are checked for NAMES, and their path fields.
ARG_TOOLS = frozenset({"write_file", "patch", "skill_manage", "cronjob_manage"})
PATH_FIELDS = ("path", "file_path")
#: Commands that read and never write. `cd` and `pwd` change nothing on disk.
READ_ONLY = frozenset({"cat", "ls", "stat", "sha256sum", "shasum", "md5sum", "head", "tail", "wc", "file", "jq",
                       "grep", "egrep", "fgrep", "rg", "diff", "cmp", "readlink", "realpath", "test", "[", "cd",
                       "pwd", "find", "echo", "pushd", "popd"})
FIND_ACTIONS = frozenset({"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"})
#: Commands that move, copy onto, remove, link or re-permission their arguments (rule 3b, the Hermes home).
MUTATING = frozenset({"mv", "cp", "rm", "rmdir", "ln", "rsync", "install", "unlink", "shred", "chmod", "chown",
                      "chgrp", "chattr", "setfacl", "tar", "unzip", "cpio", "rename", "mount", "find"})
#: The Hermes home as a whole argument, lower-cased. The real `$HERMES_HOME` is added per call, and `~`,
#: `$HOME` too when `$HOME` is the Hermes home.
HOME_WORDS = frozenset({"$hermes_home", "${hermes_home}", "~/.hermes", "$home/.hermes", "${home}/.hermes", "/opt/data"})
#: Opaque syntax: the name or the content may be made where the text does not show it.
OPAQUE_SYNTAX = re.compile(r"\$\(|`|<\(|>\(|\$'|\$\"|\\[0-7xuU]|\$\{[A-Za-z_][A-Za-z0-9_]*[^A-Za-z0-9_}]"
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
#: M1/M2 (review-b ov#633): the installed code that enforces the setting, by folder (parts of a path, in order).
#: Skills and plugins are installed at the same relative path under the Hermes home (install/install.ts:267
#: copySkillBundles; install/install_approval.ts:290-297 stagePlugins). Every file in these folders is the
#: overlay's: the agent writes its own skills elsewhere (skill_manage) and installs no plugins.
CODE_DIRS = (("plugins", "av-events"), ("plugins", "av_events"), ("plugins", "village-bridge"),
             ("skills", "index-network", "scripts"), ("skills", "zzzbot", "scripts"))
#: The folders above them: renaming or removing one takes the code with it.
CODE_PARENTS = (("plugins",), ("skills",), ("skills", "index-network"), ("skills", "zzzbot"), ("scripts",))
#: `$HERMES_HOME/scripts/` is shared with the agent's own cron scripts, so there the guard goes by name: the
#: installers' scripts (the zzz runners, the pairs shim, the proactive shims and the other agentvillage_*
#: scripts) all carry one of these names (install/install_index.ts:322-325,356,442,466; install/zzz_autonomy_job.ts:15;
#: install/zzz_managed_job.ts:12-13). A closure test holds every staged name to this.
SCRIPT_PREFIXES = ("agentvillage_",)
SCRIPT_NAMES = frozenset({"zzz_autonomy_runner.py", "zzz_managed_runner.py"})
_SCRIPT_SAMPLES = ("zzz_autonomy_runner.py", "zzz_managed_runner.py", "agentvillage_zzz_pairs.sh",
                   "agentvillage_proactive_brief.sh")
#: Pieces that name that code in a file's text, in code or in an inline interpreter: with them a write or a
#: no-agent cron script could edit it later.
CODE_NAME_PIECES = ("plugins/av-events", "plugins/av_events", "plugins/village-bridge", "_setting_guard",
                    "zzz_autonomy_runner", "zzz_managed_runner", "_zzz_managed", "index-network/scripts",
                    "zzzbot/scripts", "agentvillage_", "hermes_safe_mode")
#: The policy scripts a glob may stand for (S1): the operator command and the two readers.
POLICY_SCRIPTS = ("post_village_policy.ts", "post-village-policy.ts", "_post_village_policy.py", SETTING_NAME)
_POLICY_SCRIPT_LITERALS = ("post", "vill", "polic")
#: The nine policy keys (skills/index-network/scripts/post-village-policy.ts POST_VILLAGE_KEYS).
POLICY_KEYS = ("daily_digest", "opportunity_midday", "opportunity_evening", "negotiation_summary", "pending_alert",
               "zzz_pairs", "zzz_event_autonomy", "zzz_owner_repeating", "welcome_seed")
_ENABLED_LIST = re.compile(r"enabled\s*:\s*\[")
#: Commands that write their arguments, and those that write only their last argument (or `-t DIR`).
WRITE_ALL = frozenset({"rm", "rmdir", "unlink", "shred", "truncate", "touch", "chmod", "chown", "chgrp", "chattr",
                       "setfacl", "tee", "mv", "patch", "ed", "ex", "vi", "vim", "nvim", "nano", "emacs", "sponge",
                       "tar", "unzip", "cpio", "rename"})
WRITE_LAST = frozenset({"cp", "ln", "install", "rsync"})
IN_PLACE = frozenset({"sed", "perl", "gawk", "awk"})
#: Interpreters: inline code (`-c`, `-e`, ..., or code on stdin) may name anything.
INTERPRETERS = frozenset({"node", "nodejs", "bun", "deno", "perl", "ruby", "php", "lua", "sh", "bash", "zsh", "dash",
                          "ksh", "fish", "awk", "gawk", "tclsh"})
INLINE_RUNNERS = frozenset({"eval", "xargs", "source", ".", "parallel", "busybox", "expect", "sqlite3", "env", "sudo"})
INLINE_FLAGS = frozenset({"-c", "-e", "-E", "--eval", "-p", "-pe", "-pi", "-ne", "-ie", "-r"})
#: M1: Hermes loads a plugin only when config.yaml's `plugins.enabled` lists it and `plugins.disabled` does not
#: (Hermes v2026.9.24 hermes_cli/plugins_discovery.py:87-106, hermes_cli/plugins.py:1370-1381); HERMES_SAFE_MODE
#: loads none (hermes_cli/plugins.py:1276-1277).
PLUGIN_NAMES = ("av-events", "av_events")
CONFIG_WORDS = ("av-events", "av_events", "plugins", "enabled", "disabled", "safe_mode")
HERMES_PLUGIN_VERBS = frozenset({"disable", "remove", "rm", "uninstall", "update"})
#: M2: the cron store's covered jobs (the readers' JOB_NAMES; a closure test holds both equal) and the actions
#: that switch one on or change what it runs. A pause or a removal always passes.
COVERED_JOBS = {
    "Edge — daily digest": "daily_digest", "Edge — digest prepare": "daily_digest",
    "Edge — template: brief": "daily_digest", "Edge — template: digest-preview": "daily_digest",
    "Edge — opportunity drop (midday)": "opportunity_midday", "Edge — opportunity drop (evening)": "opportunity_evening",
    "Edge — negotiation summary": "negotiation_summary", "Edge — pending opportunity": "pending_alert",
    "Edge — zzz pairs": "zzz_pairs", "Edge — zzz event autonomy": "zzz_event_autonomy",
}
CRON_ON_ACTIONS = frozenset({"resume", "enable", "update", "edit", "run", "run_now", "trigger"})
#: The runner's own pin of the Python reader (skills/zzzbot/scripts/zzz_autonomy_runner.py POLICY_READER_SHA256);
#: a closure test holds the three equal. The cron rule runs the reader only with these bytes.
POLICY_READER_SHA256 = "57c6ad036e45d397dffb6305059e92e09d03b7e116fcebdb2ad68cbacf4f765d"
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


def _is_folder_part(part: str) -> bool:
    """A path part that is, or as a glob could be, `av-events`."""
    return part == SETTING_DIR or bool(_GLOB_CHARS & set(part) and _could_match(part, SETTING_DIR))


def _in_folder(path: str) -> bool:
    """`path` (lower case) has `av-events` (or a glob for it) as one of its parts: it lies in or under it."""
    return any(_is_folder_part(part) for part in path.split("/"))


def _is_home(path: str, homes: frozenset) -> bool:
    return path in homes or path.rsplit("/", 1)[-1] == ".hermes"


def _above_home(prefix: str, homes: frozenset) -> bool:
    """An absolute `prefix` that is the Hermes home or one of its ancestors (`**` below it reaches the file)."""
    if prefix in ("", "/"):
        return True
    return _is_home(prefix, homes) or any(home.startswith(prefix.rstrip("/") + "/") for home in homes)


def _place(target: str, homes: frozenset, placed: tuple) -> tuple:
    """(in av-events, in the Hermes home) after `cd target`, from `placed`, the same before it."""
    path = _as_path(target)
    if path == ".." and placed[0]:
        return (False, True)
    if path in ("", "."):
        return placed
    if _in_folder(path):
        return (True, False)
    return (False, _is_home(path, homes))


def _glob_names_setting(word: str, homes: frozenset, placed: tuple) -> bool:
    """A glob word that could match the setting's basename where the command itself puts it: a parent part that
    is (or could be) `av-events`, a `**` below the Hermes home or one of its ancestors, or a relative glob after
    a `cd`/`pushd` (or `workdir`) into `av-events` (`**`: or into the home). A bare glob with no such placement
    passes: the shell's folder from an earlier call is not known here."""
    if not _GLOB_CHARS & set(word):
        return False
    parts = word.split("/")
    if not parts[-1] or not _could_match(parts[-1], SETTING_NAME):
        return False
    if len(parts) > 1 and _is_folder_part(parts[-2]):
        return True
    if "**" in parts[:-1] or parts[-1] == "**":
        prefix = "/".join(parts[:parts.index("**")])
        if word.startswith("/") and _above_home(prefix, homes):
            return True
        if _in_folder(prefix) or _is_home(prefix, homes):
            return True
        return not word.startswith(("/", "~", "$")) and (placed[0] or placed[1])
    relative = len(parts) == 1 or (not word.startswith(("/", "~", "$")) and all(p in (".", "") for p in parts[:-1]))
    return relative and placed[0]


def names_setting(text: str, homes: frozenset = HOME_WORDS) -> bool:
    """The flattened text names the setting: NAMES, or a glob word that could match it where the command puts
    it (`_glob_names_setting`; `cd`/`pushd` targets are followed left to right)."""
    if _NAMES.search(text):
        return True
    placed = (False, False)
    words = [word for word in _WORD_SPLIT.split(text) if word]
    for i, word in enumerate(words):
        if word in ("cd", "pushd") and i + 1 < len(words):
            placed = _place(words[i + 1], homes, placed)
        elif _glob_names_setting(word, homes, placed) or _glob_names_policy_script(word):
            return True
    return False


def _glob_names_policy_script(word: str) -> bool:
    """S1: a glob for one of the policy scripts (the operator command, the two readers) or the setting, anywhere,
    when its literal part carries a piece of their name (`post_vill*.ts`, `post-village-*.ts`, `*polic*.py`); a
    bare `*.ts` does not."""
    last = word.rsplit("/", 1)[-1]
    if not _GLOB_CHARS & set(last):
        return False
    literal = re.sub(r"[*?\[\]{},]", "", last)
    return (any(piece in literal for piece in _POLICY_SCRIPT_LITERALS)
            and any(_could_match(last, name) for name in POLICY_SCRIPTS))


def _segments(command: str) -> List[List[str]]:
    """Cached: one terminal call is read by several rules (review-a N3)."""
    return [list(segment) for segment in _segments_cached(command)]


@functools.lru_cache(maxsize=8)
def _segments_cached(command: str) -> tuple:
    return tuple(tuple(segment) for segment in _segments_uncached(command))


def _segments_uncached(command: str) -> List[List[str]]:
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


def _safe_target(token: str, target: str, in_folder: bool, homes: frozenset = HOME_WORDS) -> bool:
    """A write redirect that provably misses the setting: /dev/null, a descriptor copy, or a literal path that
    names nothing of the setting, holds no glob or variable, does not lie in `av-events`, and is not relative
    after a `cd` into it. A read-write `<>` never is."""
    if "<" in token:
        return False
    if target == "/dev/null" or (token.endswith("&") and (target.isdigit() or target == "-")):
        return True
    path = target.lower()
    if (not path or _NAMES.search(flat(path)) or _GLOB_CHARS & set(path) or "`" in path
            or ("$" in path and not path.startswith(("$hermes_home/", "${hermes_home}/", "$home/", "${home}/")))):
        return False
    if _in_folder(path):
        return False
    folded = _as_path(path)
    if _in_folder(folded) or _code_path(folded, homes) or _code_parent(folded, homes) or _home_config(folded, homes, False):
        return False  # bypass 3: never a safe target onto the code or config the other rules guard
    return path.startswith(("/", "~", "$")) or not in_folder


def _words(segment: List[str], in_folder: bool = False, homes: frozenset = HOME_WORDS) -> Optional[List[str]]:
    """A simple command's words without its redirections, or None when it writes through one that is not a
    `_safe_target`, or reads a heredoc or here-string."""
    words, skip = [], False
    for i, token in enumerate(segment):
        if skip:
            skip = False
        elif token.startswith("<<"):
            return None
        elif ">" in token:
            target = segment[i + 1] if i + 1 < len(segment) else ""
            if not _safe_target(token, target, in_folder, homes):
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


def read_only(command: str, homes: frozenset = HOME_WORDS) -> bool:
    """Every simple command reads only (READ_ONLY, or the operator command's status), with no assignment, no
    heredoc, no OPAQUE_SYNTAX and no write redirect except to a `_safe_target` (a copy of a read to a file
    outside `av-events` passes). Text shlex cannot read is not read-only."""
    if OPAQUE_SYNTAX.search(command):
        return False
    try:
        segments = _segments(command)
    except ValueError:
        return False
    placed = (False, False)
    for segment in segments:
        words = _words(segment, placed[0], homes)
        if words is None:
            return False
        if not words:
            continue
        if _ASSIGN.match(words[0]):
            return False
        name, args = _split_command(words)
        if name in ("cd", "pushd") and args:
            placed = _place(args[0], homes, placed)
        if not (_operator_status(words) or _reads_only(name, args)):
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
    """An argument as a path: the value after a `--flag=`, `of=` or `NAME=`, lower case, `.` and `..` parts
    folded (posixpath.normpath: `plugins/x/../av-events` is `plugins/av-events`), without a trailing `/`.
    Text alone cannot see a symlink: one made in an earlier call is not followed (state across calls)."""
    value = word.rsplit("=", 1)[-1].lower()
    if value:
        value = posixpath.normpath(_home_spelled(value))
    return "" if value == "." else value


#: The real homes of the call being judged (set by `matches`): $HERMES_HOME's value, and $HOME's.
_CALL_HOMES: "contextvars.ContextVar[tuple]" = contextvars.ContextVar("av_setting_guard_homes", default=("", ""))
_HOME_PARAM = re.compile(r"^\$\{hermes_home(?:[^a-z0-9_}][^}]*)?\}")
_TILDE_USER = re.compile(r"^~[a-z0-9_.-]+(?=/|$)")


def _home_spelled(value: str) -> str:
    """S2 (review-a): a leading `//` is `/`; any `${HERMES_HOME...}` parameter form (`%/`, `:-x`, ...) is
    $HERMES_HOME; `~user` is taken as the Hermes home; and $HERMES_HOME, `~` and $HOME are replaced by the real
    paths when known, so `$HERMES_HOME/../<its name>` folds back onto the home."""
    if value.startswith("//"):
        value = "/" + value.lstrip("/")
    value = _HOME_PARAM.sub("$hermes_home", value)
    value = _TILDE_USER.sub("$hermes_home", value)
    hermes_home, user_home = _CALL_HOMES.get()
    for spelling, real in (("$hermes_home", hermes_home), ("~", user_home), ("$home", user_home),
                           ("${home}", user_home)):
        if real and (value == spelling or value.startswith(spelling + "/")):
            return real + value[len(spelling):]
    return value


def _could_be_home(parent: str, homes: frozenset, in_home: bool) -> bool:
    """A folder the command itself puts at the Hermes home: one of `homes`, a `.hermes`, a glob that could match
    the home's own name, or `.` after a `cd`/`pushd` (or `workdir`) into the home."""
    if _is_home(parent, homes):
        return True
    part = parent.rsplit("/", 1)[-1]
    if part == "." and "/" not in parent:
        return in_home
    names = {home.rsplit("/", 1)[-1] for home in homes if "/" in home} | {".hermes"}
    return bool(_GLOB_CHARS & set(part)) and any(_could_match(part, name) for name in names if name)


def _names_folder(path: str, homes: frozenset, in_home: bool) -> bool:
    """`path` is the `av-events` folder itself, or a glob for it in a folder the command puts at the Hermes home
    (a bare glob only after a `cd`/`pushd` or `workdir` into the home)."""
    parent, _, last = path.rpartition("/")
    if last == SETTING_DIR:
        return True
    if not (_GLOB_CHARS & set(last) and _could_match(last, SETTING_DIR)):
        return False
    return in_home if "/" not in path else _could_be_home(parent, homes, in_home)


def _find_reaches(start: str, homes: frozenset, placed: tuple) -> bool:
    """A `find` start folder from which it walks down to the setting: `av-events`, the Hermes home, an ancestor
    of it, the user's home, or a relative start after a `cd`/`pushd` or `workdir` into the home or `av-events`."""
    path = _as_path(start)
    user_home = _CALL_HOMES.get()[1]
    # Coordinator A: `_as_path` turns `~`, $HOME, ${HOME} into the real user home, so that path (and the literal
    # spellings, when HOME is unknown) both count.
    if (_in_folder(path) or _is_home(path, homes) or path in ("~", "$home", "${home}")
            or (user_home and path == user_home)):
        return True
    if path.startswith("/"):
        return _above_home(path, homes)
    return not path.startswith(("~", "$")) and (placed[0] or placed[1])


def _find_recurses_to_setting(name: str, args: List[str], homes: frozenset, placed: tuple) -> bool:
    """`find` with an action flag and a -name/-iname/-path/-ipath/-wholename pattern that could match the setting,
    when the pattern holds a piece of the file's own name (find walks down from wherever it starts) or a start
    folder reaches it (`_find_reaches`). `find . -name '*.json' -delete` with no such placement passes."""
    if name != "find" or not FIND_ACTIONS & set(args):
        return False
    first = next((i for i, arg in enumerate(args) if arg.startswith(("-", "(", "!")) and arg not in ("-H", "-L", "-P")),
                 len(args))
    starts = [arg for arg in args[:first] if arg not in ("-H", "-L", "-P")] or ["."]
    for flag, pattern in zip(args, args[1:]):
        pattern = pattern.lower()
        if flag in ("-name", "-iname"):
            hit = _could_match(pattern, SETTING_NAME)
        elif flag in ("-path", "-ipath", "-wholename", "-iwholename"):
            hit = (_could_match(pattern, f"/x/{SETTING_DIR}/{SETTING_NAME}")
                   or _could_match(pattern, f"./{SETTING_DIR}/{SETTING_NAME}"))
        else:
            continue
        if hit and (any(piece in pattern for piece in CODE_PIECES)
                    or any(_find_reaches(start, homes, placed) for start in starts)):
            return True
    return False


def _swaps_folder(command: str, environ: Mapping[str, str]) -> bool:
    """Rule 3b: a command that is not read-only takes `av-events` itself as an argument (or a glob for it where
    the command puts it), a MUTATING command takes the Hermes home itself, or a `find` with an action looks for
    the setting by name. Text shlex cannot read counts when it holds a FRAGMENT."""
    try:
        segments = _segments(command)
    except ValueError:
        return _has_fragment(flat(command))
    homes = _home_words(environ)
    placed = (False, False)
    for segment in segments:
        words = [token for token in segment if ">" not in token and token != "<"]
        if not words:
            continue
        name, args = _split_command(words)
        if name in ("cd", "pushd") and args:
            placed = _place(args[0], homes, placed)
        if _find_recurses_to_setting(name, args, homes, placed):
            return True
        if _reads_only(name, args):
            continue
        for word in args:
            path = _as_path(word)
            if _names_folder(path, homes, placed[1]):
                return True
            if name in MUTATING and _is_home(path, homes):
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


def _allow_shape(text: str) -> bool:
    """S1: the allow list, whatever file or script carries it: `--enabled` or `"enabled": [` with a policy key."""
    return any(key in text for key in POLICY_KEYS) and ("--enabled" in text or bool(_ENABLED_LIST.search(text)))


def _parts(path: str) -> List[str]:
    return [part for part in path.split("/") if part not in ("", ".")]


def _seq_at(parts: List[str], seq: tuple) -> bool:
    """`seq` (folder names) appears in `parts` in order, each part equal or a glob that could match it."""
    for i in range(len(parts) - len(seq) + 1):
        if all(parts[i + j] == name or (_GLOB_CHARS & set(parts[i + j]) and _could_match(parts[i + j], name))
               for j, name in enumerate(seq)):
            return True
    return False


def _code_path(path: str, homes: frozenset = HOME_WORDS) -> bool:
    """`path` (lower case, resolved) lies in a CODE_DIRS folder, or is one of the installers' scripts by name
    (a glob for one counts only in the Hermes home's own `scripts` folder)."""
    parts = _parts(path)
    if not parts:
        return False
    if any(_seq_at(parts, seq) for seq in CODE_DIRS):
        return True
    last = parts[-1]
    if last in SCRIPT_NAMES or last.startswith(SCRIPT_PREFIXES):
        return True
    if _GLOB_CHARS & set(last) and len(parts) > 1 and _could_match(parts[-2], "scripts"):
        folder = path.rsplit("/", 1)[0]
        base = folder.rsplit("/", 1)[0] if "/" in folder else ""
        if _is_home(base, homes) or (base == "" and _is_relative(path)):
            return any(_could_match(last, sample) for sample in _SCRIPT_SAMPLES)
    return False


def _is_relative(path: str) -> bool:
    return bool(path) and not path.startswith(("/", "~", "$"))


def _code_parent(path: str, homes: frozenset) -> bool:
    """`path` is a CODE_PARENTS folder of the Hermes home. A relative path whose folder no `cd` in the command
    made known counts from the Hermes home, where the terminal starts on a box (install/config.ts:104 sets
    terminal.cwd; Hermes falls back to TERMINAL_CWD, then ~: tools/terminal_tool_config.py:48-52)."""
    for seq in CODE_PARENTS:
        suffix = "/".join(seq)
        if path == suffix or path.endswith("/" + suffix):
            prefix = path[: len(path) - len(suffix)].rstrip("/")
            if _is_home(prefix, homes) or (prefix == "" and _is_relative(path)):
                return True
    return False


def _resolve(word: str, cwd: str) -> str:
    """An argument as a path, lower case, joined to the folder a `cd` in the same command made current, then
    folded again (a `..` may climb out of that folder)."""
    path = _as_path(word)
    if cwd and path and not path.startswith(("/", "~", "$")):
        return posixpath.normpath(f"{cwd.rstrip('/')}/{path}")
    return path


#: What ends a path-like word in free text (code, a file's content).
_TEXT_DELIMS = re.compile(r"([\s'\"(),+;&|<>`=\[\]{}]+)")


def _folded(text: str) -> str:
    """`text` with every path-like word that holds a `.` or `..` part folded (bypass 1: `plugins/x/../av-events`
    in code or in a file's content). One split and one pass: linear in the text (review-a N3: the regex it
    replaces was quadratic on a long token)."""
    if "/." not in text and "./" not in text:
        return text
    out = []
    for part in _TEXT_DELIMS.split(text):
        if "/" in part and any(piece in (".", "..") for piece in part.split("/")):
            part = posixpath.normpath(part)
        out.append(part)
    return "".join(out)


def _home_config(path: str, homes: frozenset, cwd_known: bool) -> bool:
    """`path` is config.yaml of the Hermes home: in a home folder, or relative (the terminal and the file tools
    start in the Hermes home)."""
    parent, _, last = path.rpartition("/")
    if last != "config.yaml":
        return False
    return (not parent and not cwd_known) or parent in (".",) or _is_home(parent, homes)


def _write_targets(name: str, args: List[str]) -> List[str]:
    """The arguments a simple command writes, as far as its name tells: every operand of WRITE_ALL, the last
    (or `-t DIR`) of WRITE_LAST, `of=` of dd, an in-place sed/perl/awk's operands, find's start folders."""
    operands = [arg for arg in args if not arg.startswith("-")]
    if name in WRITE_ALL:
        flagged = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg in ("-C", "-d", "--directory", "-o")]
        return operands + flagged
    if name in WRITE_LAST:
        flagged = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg in ("-t", "--target-directory")]
        return operands[-1:] + flagged
    if name == "dd":
        return [arg[3:] for arg in args if arg.startswith("of=")]
    if name in IN_PLACE and any(arg.startswith(("-i", "--in-place")) or re.fullmatch(r"-\w*i\w*", arg) for arg in args):
        return operands
    if name == "find" and FIND_ACTIONS & set(args):
        return operands
    return []


def _inline_code(name: str, args: List[str]) -> bool:
    """A simple command that runs text it carries (or reads from stdin), not a script file."""
    if name in INLINE_RUNNERS:
        return True
    if name in INTERPRETERS or name.startswith("python"):
        operands = [arg for arg in args if not arg.startswith("-")]
        return bool(INLINE_FLAGS & set(args)) or not operands
    return False


def _is_hermes_word(word: str, previous: str) -> bool:
    """`hermes` by any path, or the module after `-m` (`python -m hermes_cli...`)."""
    base = word.rsplit("/", 1)[-1].lower()
    return base == "hermes" or (previous == "-m" and base.startswith("hermes_cli"))


def _hermes_anywhere(words: List[str], environ: Mapping[str, str]) -> bool:
    """S1 (review-a): the hermes rules for every word that is hermes by any spelling, whatever wraps it (`env`,
    `nice`, `command`, `nohup`, `timeout N`, `time`, `sudo -u x`, `uv run`, `python -m hermes_cli.main`, an
    absolute or home path), on every word after it."""
    return any(_is_hermes_word(word, words[i - 1] if i else "") and _hermes_refuses("hermes", words[i + 1:], environ)
               for i, word in enumerate(words))


def _hermes_refuses(name: str, args: List[str], environ: Mapping[str, str]) -> bool:
    """`hermes [global options] plugins disable|remove|rm|uninstall|update ...` naming av-events or av_events,
    `hermes config <verb> ...` naming CONFIG_WORDS, and `hermes cron resume|enable|update|edit|run ...` or
    `create|add ...` where ANY word after the verb (each value of `--opt=value` too) is a covered job the setting
    keeps off. Every word is checked, not the one a parser would pick (bypass 4: argparse takes value options
    before the positional, `--opt=value`, abbreviations such as `--na`, and global options before the group)."""
    if name != "hermes":
        return False
    lowered = [arg.lower() for arg in args]
    # Every occurrence of a group word is tried (review-a S1: `-m cron cron resume`, a global option's value).
    for group_at, group in enumerate(lowered):
        if group in ("plugins", "config", "cron") and _hermes_group_refuses(group, group_at, args, lowered, environ):
            return True
    return False


def _hermes_group_refuses(group: str, group_at: int, args: List[str], lowered: List[str],
                          environ: Mapping[str, str]) -> bool:
    verb_at = next((i for i in range(group_at + 1, len(args)) if not args[i].startswith("-")), None)
    if verb_at is None:
        return False
    verb = lowered[verb_at]
    words = []
    for arg in args[verb_at + 1:]:
        if arg == "--":
            continue
        if arg.startswith("-"):
            if "=" in arg:
                words.append(arg.split("=", 1)[1])
            continue
        words.append(arg)
    if group == "plugins":
        return verb in HERMES_PLUGIN_VERBS and any(word.lower() in PLUGIN_NAMES for word in words)
    if group == "config":
        return verb != "show" and any(piece in " ".join(args[verb_at + 1:]).lower() for piece in CONFIG_WORDS)
    if verb in ("create", "add"):
        return any(_cron_refuses(None, word, environ) for word in words)
    if verb in CRON_ON_ACTIONS:
        return any(_cron_refuses(word, None, environ) for word in words)
    return False


#: S3 (review-a): folder names that, joined in code (`os.path.join(h, 'plugins', 'av-events', ...)`), reach the code.
_JOINED = (("plugins", "av-events"), ("plugins", "av_events"), ("plugins", "village-bridge"),
           ("index-network", "scripts"), ("zzzbot", "scripts"))
#: Pieces that make a variable or a link point at the home or a guarded folder.
_GUARDED_PIECES = ("$hermes_home", "${hermes_home", "~", "/opt/data", ".hermes", "plugins", "skills", "scripts",
                   "av-events", "village-bridge", "index-network", "zzzbot")
_LINK_FLAGS = frozenset({"-s", "-l", "--symbolic-link", "--link"})


def _joined_code_folder(text: str) -> bool:
    return any(all(name in text for name in pair) for pair in _JOINED)


def _guarded_place(path: str, homes: frozenset) -> bool:
    """The home, a guarded folder, a folder above one, or anything inside them."""
    hermes_home = _CALL_HOMES.get()[0]
    return (_is_home(path, homes) or _code_path(path, homes) or _code_parent(path, homes) or _in_folder(path)
            or bool(hermes_home) and path.startswith(hermes_home + "/")
            or any(path.startswith(home + "/") for home in homes if home.startswith("/")))


def _same_call_link_or_variable(segments: List[List[str]], homes: frozenset) -> bool:
    """S3 (review-a): one command that makes a link (`ln`, `cp -s|-l`, `mount --bind`) from the home or a guarded
    folder, or a variable from a piece of one, and also writes through that link's name or through a path that is
    not literal (holds `$`). Cross-call stays not caught."""
    made, risky = [], False
    writes = []
    for segment in segments:
        redirects = [segment[i + 1] for i, token in enumerate(segment[:-1]) if ">" in token]
        words = [token for i, token in enumerate(segment) if ">" not in token and token != "<"
                 and not (i and ">" in segment[i - 1])]
        name, args = _split_command(words)
        operands = [arg for arg in args if not arg.startswith("-")]
        linking = name == "ln" or (name == "cp" and _LINK_FLAGS & set(args)) or (
            name == "mount" and ("--bind" in args or "-b" in args or "--rbind" in args))
        if linking and len(operands) >= 2 and any(_guarded_place(_as_path(op), homes) for op in operands[:-1]):
            risky = True
            made.append(_as_path(operands[-1]))
        for word in words:
            if _ASSIGN.match(word) and any(piece in word.lower() for piece in _GUARDED_PIECES):
                risky = True
        writes += redirects + ([] if linking else _write_targets(name, args))  # making the link is not a write
    if not risky:
        return False
    for target in writes:
        path = _as_path(target)
        if "$" in target or any(path == link or path.startswith(link + "/") for link in made if link):
            return True
    return False


def _touches_code(command: str, environ: Mapping[str, str]) -> bool:
    """M1/M2/S1 in a terminal command: a write (redirect target or written argument) into the code that enforces
    the setting or onto the home's config.yaml, a removal or rename of a folder above that code, inline code that
    names it, `hermes plugins|config|cron` forms, or HERMES_SAFE_MODE. A `cd`/`pushd` (or `workdir`) makes later
    relative paths resolve under it. Text shlex cannot read counts when it names that code."""
    text = flat(command)
    try:
        segments = _segments(command)
    except ValueError:
        return any(piece in text for piece in CODE_NAME_PIECES)
    homes = _home_words(environ)
    if _same_call_link_or_variable(segments, homes):
        return True
    cwd = ""
    for segment in segments:
        redirects = [segment[i + 1] for i, token in enumerate(segment[:-1])
                     if ">" in token and segment[i + 1] != "/dev/null" and not segment[i + 1].isdigit()]
        words = [token for i, token in enumerate(segment) if ">" not in token and token != "<"
                 and not (i and ">" in segment[i - 1])]
        name, args = _split_command(words)
        if name in ("cd", "pushd") and args:
            target = _as_path(args[0])
            cwd = target if target.startswith(("/", "~", "$")) else _resolve(target, cwd)
            continue
        if _hermes_anywhere(words, environ):
            return True
        targets = [_resolve(word, cwd) for word in redirects + _write_targets(name, args)]
        for path in targets:
            if _code_path(path, homes) or _code_parent(path, homes):
                return True
            if _home_config(path, homes, bool(cwd)):
                whole = name in WRITE_ALL or name in WRITE_LAST or name == "dd" or path in [_resolve(r, cwd) for r in redirects]
                if whole or any(word in text for word in CONFIG_WORDS):
                    return True
        if _inline_code(name, args) and (any(piece in text for piece in CODE_NAME_PIECES) or _joined_code_folder(text)):
            return True
    return "hermes_safe_mode" in text and (not read_only(command, homes) or _writes_through_redirect(command))


def _reader_path() -> "os.PathLike":
    """The pinned Python reader beside this plugin: `<plugins>/village-bridge/_post_village_policy.py`."""
    from pathlib import Path

    return Path(__file__).resolve().parent.parent / "village-bridge" / "_post_village_policy.py"


def _policy_allows(home: str, key: str) -> bool:
    """The setting allows `key`, read by the runner's own pinned reader (its bytes must hash to
    POLICY_READER_SHA256). Raises when the reader is missing or changed: the caller refuses."""
    import hashlib

    raw = open(_reader_path(), "rb").read(65536)
    if hashlib.sha256(raw).hexdigest() != POLICY_READER_SHA256:
        raise ValueError("reader-changed")
    module: dict = {"__name__": "av_events_setting_guard_policy_reader"}
    exec(compile(raw, "<post-village-policy>", "exec"), module)  # noqa: S102 - pinned bytes, as the runner does
    return module["allowed"](home, key) is True


def covered_jobs() -> dict:
    return dict(COVERED_JOBS)


def _covered_key(name: Any) -> Optional[str]:
    if not isinstance(name, str):
        return None
    lowered = name.strip().lower()
    return next((key for job, key in COVERED_JOBS.items() if job.lower() == lowered), None)


def _store_job_name(home: str, ref: str) -> Optional[str]:
    """The name of the cron store's job `ref` (an id, else a name in any case, as Hermes resolves it:
    cron/jobs.py resolve_job_ref), read only; None when there is none. Raises when the store cannot be read."""
    import json
    from pathlib import Path

    path = Path(home) / "cron" / "jobs.json"
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        data = json.loads(stream.read(16 * 1024 * 1024 + 1))
    jobs = data.get("jobs") if isinstance(data, dict) else None
    if not isinstance(jobs, list):
        raise ValueError("store-invalid")
    jobs = [job for job in jobs if isinstance(job, dict)]
    for job in jobs:
        if job.get("id") == ref:
            return str(job.get("name") or "")
    named = [job for job in jobs if str(job.get("name") or "").lower() == ref.lower()]
    return str(named[0].get("name") or "") if len(named) == 1 else None


def _cron_refuses(ref: Optional[str], name: Optional[str], environ: Mapping[str, str]) -> bool:
    """A job switched on or changed by `ref` (id or name) or created as `name` is refused when it is a covered job
    and the setting does not allow its key. Fail closed: a store or reader that cannot be read refuses."""
    home = str(environ.get("HERMES_HOME", "") or "").strip()
    key = _covered_key(name if name is not None else ref)
    if key is None and ref is not None:
        try:
            key = _covered_key(_store_job_name(home, ref))
        except Exception:  # noqa: BLE001 - the store cannot be read: fail closed
            return True
    if key is None:
        return False
    try:
        return not _policy_allows(home, key)
    except Exception:  # noqa: BLE001 - the reader is missing or changed: fail closed
        return True


def _cron_tool_refuses(args: dict, environ: Mapping[str, str]) -> bool:
    """`cronjob_manage` create with a covered `name`; resume/enable/update/edit/run/run_now/trigger whose
    `job_id` (a string, or each string of a list) is a covered job, or whose `name` (an update renames) is a
    covered name; unless the setting allows the job."""
    action = str(args.get("action") or "").strip().lower()
    names = [args["name"]] if isinstance(args.get("name"), str) else []
    if action == "create":
        return any(_cron_refuses(None, job, environ) for job in names)
    if action not in CRON_ON_ACTIONS:
        return False
    raw = args.get("job_id")
    refs = [raw] if isinstance(raw, str) else [ref for ref in raw if isinstance(ref, str)] if isinstance(raw, (list, tuple)) else []
    return (any(_cron_refuses(ref.strip(), None, environ) for ref in refs if ref.strip())
            or any(_cron_refuses(None, job, environ) for job in names))


def _v4a_paths(text: str) -> List[str]:
    return re.findall(r"^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$", text, re.M)


def _config_keeps_av_events(content: str) -> bool:
    """config.yaml's text still loads av-events: `plugins.enabled` lists it and `plugins.disabled` does not."""
    try:
        import yaml  # Hermes ships PyYAML

        doc = yaml.safe_load(content)
    except Exception:  # noqa: BLE001 - unreadable: it may not load av-events
        return False
    plugins = doc.get("plugins") if isinstance(doc, dict) else None
    if not isinstance(plugins, dict):
        return False
    enabled, disabled = plugins.get("enabled"), plugins.get("disabled") or []
    return (isinstance(enabled, list) and "av-events" in enabled and isinstance(disabled, list)
            and not any(name in disabled for name in PLUGIN_NAMES))


def _real_config(path: str, environ: Mapping[str, str]) -> str:
    """The home's config.yaml as it is now (for a patch), read only, at most 1 MiB. Raises if unreadable."""
    home = str(environ.get("HERMES_HOME", "") or "").strip()
    with open(os.path.join(home, "config.yaml"), "r", encoding="utf-8") as stream:
        return stream.read(1024 * 1024)


def _file_tool_refuses(tool_name: str, args: dict, environ: Mapping[str, str]) -> bool:
    """M1/M2 for write_file, patch, skill_manage, cronjob_manage: a path into the guarded code or a folder above
    it, its name in the text, HERMES_SAFE_MODE, the allow-list shape, a config.yaml that would not load
    av-events, an overlay skill's scripts, or a covered cron job switched on."""
    homes = _home_words(environ)
    texts = [_folded(flat(text)) for text in _strings(args)]
    if any(piece in text for text in texts for piece in CODE_NAME_PIECES) or any(_allow_shape(text) for text in texts):
        return True
    paths = [args[field] for field in PATH_FIELDS if isinstance(args.get(field), str)]
    if isinstance(args.get("patch"), str):
        paths += _v4a_paths(args["patch"])
    for raw in paths:
        path = _as_path(raw)
        if _code_path(path, homes) or _code_parent(path, homes):
            return True
        if tool_name in ("write_file", "patch") and _home_config(path, homes, False):
            if tool_name == "write_file":
                content = args.get("content")
                if not isinstance(content, str) or not _config_keeps_av_events(content):
                    return True
            else:
                old, new = args.get("old_string"), args.get("new_string")
                if args.get("mode") == "patch" or not isinstance(old, str) or not isinstance(new, str):
                    return True
                try:
                    current = _real_config(path, environ)
                except Exception:  # noqa: BLE001 - the file cannot be read: fail closed
                    return True
                if old not in current:
                    return True
                after = current.replace(old, new) if args.get("replace_all") else current.replace(old, new, 1)
                if not _config_keeps_av_events(after):
                    return True
    if tool_name == "skill_manage" and _skill_manage_refuses(args):
        return True
    return tool_name == "cronjob_manage" and _cron_tool_refuses(args, environ)


_OVERLAY_SKILLS = ("index-network", "zzzbot")


def _skill_manage_refuses(args: dict) -> bool:
    """M1 (review-a): `skill_manage` as Hermes advertises it is an `operations` array, each op naming its skill
    (an op without `name` takes the top-level one: tools/skill_manager_tool.py:769-771); the legacy flat shape is
    the top level itself. Any entry on an overlay skill that deletes it, or touches its `scripts` (write_file,
    patch, remove_file), is refused. An `operations` that is not a list is refused when it mentions an overlay
    skill."""
    top = str(args.get("name") or "")
    raw = args.get("operations")
    if raw is not None and not isinstance(raw, list):
        return any(skill in text.lower() for text in _strings(raw) for skill in _OVERLAY_SKILLS)
    entries = [args] + [op for op in (raw or []) if isinstance(op, dict)]
    for entry in entries:
        skill = str(entry.get("name") or top).strip().lower()
        if skill not in _OVERLAY_SKILLS:
            continue
        action = str(entry.get("action") or "").strip().lower()
        if action in ("delete", "remove") or _skill_file_path_refuses(entry.get("file_path")):
            return True
    return False


def _skill_file_path_refuses(raw: Any) -> bool:
    """An overlay skill's `file_path` read the way Hermes reads it: the path itself (no `=` split), `.` parts and
    doubled slashes dropped (pathlib `Path(file_path).parts`, tools/skill_manager_tool.py:322). Refused when any
    part is `scripts` (case folded: boxes are Linux and case-sensitive, so `Scripts/` only over-refuses), or when it
    is absolute or still holds `..` (Hermes rejects both itself: `..` at tools/path_security.py:17-19 via
    skill_manager_tool.py:324, a first part outside references/templates/scripts/assets at :329)."""
    path = str(raw or "").strip().lower()
    if not path:
        return False
    parts = posixpath.normpath(path).split("/")
    return path.startswith("/") or ".." in parts or "scripts" in parts


def _writes_through_redirect(command: str) -> bool:
    """Any write redirect other than to /dev/null or a descriptor (text shlex cannot read counts)."""
    try:
        segments = _segments(command)
    except ValueError:
        return True
    return any(">" in token and not (i + 1 < len(segment) and (segment[i + 1] == "/dev/null"
                                                              or segment[i + 1].isdigit() or segment[i + 1] == "-"))
               for segment in segments for i, token in enumerate(segment))


def _terminal_refuses(command: str, environ: Mapping[str, str]) -> bool:
    text = flat(command)
    homes = _home_words(environ)
    if _allow_shape(text) and (not read_only(command, homes) or _writes_through_redirect(command)):
        return True
    named = names_setting(text, homes)
    if named and not read_only(command, homes):
        return True
    # Bypass 3: a read-only command that names the setting still goes through every other rule.
    if _touches_code(command, environ):
        return True
    if _swaps_folder(command, environ):
        return True
    if named:
        return False  # provably read-only: no opaque syntax, only READ_ONLY commands or the status shape
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
    token = _CALL_HOMES.set((str(environ.get("HERMES_HOME", "") or "").strip().rstrip("/").lower(),
                             str(environ.get("HOME", "") or "").strip().rstrip("/").lower()))
    try:
        return _matches(tool_name, args, environ)
    finally:
        _CALL_HOMES.reset(token)


def _matches(tool_name: str, args: dict, environ: Mapping[str, str]) -> bool:
    if tool_name in ARG_TOOLS:
        if any(_NAMES.search(flat(text)) for text in _strings(args)):
            return True
        if any(isinstance(args.get(field), str) and _as_path(args[field]).rsplit("/", 1)[-1] == SETTING_DIR
               for field in PATH_FIELDS):
            return True
        return _file_tool_refuses(tool_name, args, environ)
    if tool_name == "execute_code":
        code = args.get("code")
        if not isinstance(code, str):
            return False
        text = _folded(flat(code))
        return (any(piece in text for piece in CODE_PIECES + CODE_NAME_PIECES) or _allow_shape(text)
                or _joined_code_folder(text)
                or names_setting(text, _home_words(environ)))
    command = _command_text(tool_name, args)
    return command is not None and _terminal_refuses(command, environ)


#: What the matcher-error fallback (and an oversized call) looks for: any piece of the setting, of the code that
#: enforces it, or a covered job's name.
_FALLBACK_PIECES = FRAGMENTS + CODE_NAME_PIECES + tuple(job.lower() for job in COVERED_JOBS)
#: Size cap (review-a N3, coordinator's correction: it fails closed). With the fold linear it is a safety net, not
#: the main defence. A command or code string over MAX_TEXT is refused as too long to check. In the file and
#: structured tools a content field over MAX_TEXT gets the piece check and is left out of the full rules; every
#: other string (path, name, skill, action, job id, mode) is judged in full at any size, and refused over MAX_SHORT.
MAX_TEXT = 256 * 1024
MAX_SHORT = 4096
REFUSAL_TOO_LONG = ("Refused by Agent Village: this call is too long to check against the operator's post-village "
                    "setting (over 256 KB of command or code, or over 4 KB in a path, name or id). Split it into "
                    "smaller calls.")
#: The content fields of the structured tools (Hermes v0.21.5: write_file `content`, patch `old_string`/`new_string`/
#: V4A `patch`, skill_manage `content`/`file_content`/`old_string`/`new_string`, cronjob_manage `prompt`).
_BODY_KEYS = frozenset({"content", "file_content", "old_string", "new_string", "patch", "prompt"})


class _TooLong(Exception):
    pass


def _pieces_hit(args: Any) -> bool:
    return isinstance(args, (dict, list, str)) and any(any(piece in text.lower() for piece in _FALLBACK_PIECES)
                                                       or _NAMES.search(text.lower()) for text in _strings(args))


def _sized(value: Any, key: str, bodies: List[str], depth: int = 0) -> Any:
    """`value` with every content field over MAX_TEXT taken out into `bodies` (a V4A patch keeps its file header
    lines, which name the paths it writes). Raises _TooLong for any other string over MAX_SHORT."""
    if depth > 32:
        raise _TooLong
    if isinstance(value, str):
        if key in _BODY_KEYS:
            if len(value) <= MAX_TEXT:
                return value
            bodies.append(value)
            return "\n".join(_v4a_headers(value)) if key == "patch" else ""
        if len(value) > MAX_SHORT:
            raise _TooLong
        return value
    if isinstance(value, dict):
        return {k: _sized(v, k if isinstance(k, str) else "", bodies, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [_sized(v, key, bodies, depth + 1) for v in value]
    return value


def _v4a_headers(text: str) -> List[str]:
    return [line for line in text.splitlines() if line.startswith("*** ")]


def _size_directive(tool_name: Any, args: Any) -> Any:
    """None when the call is within the caps; a block directive; or `(args, bodies)`: the args to judge in full
    and the oversized content to piece-check."""
    if not isinstance(tool_name, str) or not isinstance(args, dict):
        return None
    if tool_name in ("terminal", "process_manage", "execute_code"):
        text = args.get("code") if tool_name == "execute_code" else _command_text(tool_name, args)
        if isinstance(text, str) and len(text) > MAX_TEXT:
            return {"action": "block", "message": REFUSAL_TOO_LONG}
        return None
    if tool_name not in ARG_TOOLS:
        return None
    bodies: List[str] = []
    try:
        reduced = _sized(args, "", bodies)
    except _TooLong:
        return {"action": "block", "message": REFUSAL_TOO_LONG}
    if not bodies:
        return None
    if any(_pieces_hit(body) for body in bodies):
        return {"action": "block", "message": REFUSAL}
    return reduced, bodies


def safe_directive(tool_name: Any, args: Any, environ: Optional[Mapping[str, str]] = None,
                   matcher=None) -> Optional[dict]:
    """The block directive for a matching call, else None. Never raises: Hermes blocks EVERY call whose
    `pre_tool_call` callback raises (hermes_cli/plugins_dispatch.py:229-242), so a bug here must not reach it.
    If the matcher fails, the call is refused when any string argument holds a piece of the guarded names
    (_FALLBACK_PIECES, NAMES), else allowed with one warning (no text). No switch turns it off. `matcher` is for
    tests."""
    try:
        sized = _size_directive(tool_name, args)
        if isinstance(sized, dict):
            return sized
        hit = (matcher or matches)(tool_name, sized[0] if sized else args, environ)
        return {"action": "block", "message": REFUSAL} if hit else None
    except BaseException:  # noqa: BLE001 - a raise here would block every tool call
        try:
            if _pieces_hit(args):
                return {"action": "block", "message": REFUSAL}
        except BaseException:  # noqa: BLE001
            pass
        try:
            logger.warning("av-events: setting_guard matcher failed; call allowed")
        except BaseException:  # noqa: BLE001
            pass
        return None


__all__ = ["SETTING_NAME", "SETTING_DIR", "REFUSAL", "FRAGMENTS", "READ_ONLY", "CODE_DIRS", "SCRIPT_NAMES",
           "COVERED_JOBS", "POLICY_READER_SHA256", "flat", "names_setting", "read_only", "covered_jobs", "matches",
           "safe_directive"]
