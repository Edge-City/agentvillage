"""The plugin's approval.md client and its poller (DATA-212 Lane B).

The resident's approval.md daemon runs beside the gateway (DATA-233: a
loopback port or a unix socket owned by the daemon's uid) or, for the hosted
dogfood, behind an https facade. Its agent surface is `approval serve`'s
`POST /verb/<name>` with `{"positionals": [...], "flags": {...}}`, answered
`{exit_code, stdout, stderr, stdout_truncated, stderr_truncated}` (core
`src/serve/server.ts`, `streamsBody`; approval.md PR #569). This module speaks
four verbs of it, and decides nothing about what an answer means for an
intention: `_intent_approval` does that.

- `propose --class --key --summary --payload-json --json` (no positionals);
- `wait <task> --timeout 0 --json`: exit 0 granted (or `executed`, or
  `nothing-to-wait-for`, which `status` names), 1 rejected / revoked /
  withdrawn / `not-registered`, 3 expired, 6 still pending, 7 void. Never
  `--withdraw-on-timeout` (core refuses it beside `--timeout 0`);
- `start <task> --action <key> --payload-json <the proposed bytes> --json`;
- `withdraw <task> --reason <r> --json`.

**Configuration.** `AV_APPROVAL_ENABLED` (`1|true|yes|on`) and
`AV_APPROVAL_URL` (`http://127.0.0.1:<port>`, `http://localhost:<port>`,
`http://[::1]:<port>`, `unix:<absolute socket path>`, or an `https://` origin;
nothing else, no path, no query). The agent credential is read the way the
shell-hook shim reads it (`skills/approval/scripts/hermes-hook-shim.sh`): the
file `AV_APPROVAL_TOKEN_FILE` names, else `$HERMES_HOME/approval/agent-token`
when it exists, else `AV_APPROVAL_TOKEN`. A token file must be an absolute
path to a regular file (not a link) owned by this uid with mode 0600; a named
file that is unusable never falls back to the variable.

**The listener must be the daemon's.** Before every request to a loopback
port, every listening socket on that port (from `/proc/net/tcp` and `tcp6`)
must belong to `AV_APPROVAL_DAEMON_UID` (default 10001, the co-located
daemon's); a unix socket and its directory must be that uid's, the directory
not writable by anyone else. Otherwise nothing is sent
(`facade_listener_foreign`). This matters more here than in the shim: the
agent runs as the gateway's uid and can bind the port while the daemon is
down, and a listener that answered `granted` to `wait` and `ok` to `start`
would make the plugin publish an intention nobody approved. The module
attribute `PROC_ROOT` replaces `/proc` in tests only; no variable does.
`AV_APPROVAL_ENABLED`, `AV_APPROVAL_URL` and `AV_APPROVAL_DAEMON_UID` are read
from the process environment only, never from the live-reloaded `.env`. An https facade is not checked (TLS names it).

**Transport.** `http.client` directly: no proxy is consulted and no redirect
is followed. The credential goes in `Authorization: Bearer` (and, for an https
facade only, `X-Approval-Authorization` too, which Maritime's proxy does not
strip). Nothing this module logs carries the token, the URL's secrets, a
request body or an answer body: codes only.

**The poller.** One daemon thread per process (`ensure_poller`), started in
the gateway process (see `_intent_approval.maybe_start`), runs every
registered pass (`register_pass`) every `AV_APPROVAL_POLL_S` seconds (default
30, at least 5). A pass is also run once, in its own short-lived thread, on
`kick()` (session start, a confirm). Passes are serialised within the process
and across processes (`flock` on `$HERMES_HOME/av-events/approval-pass.lock`,
non-blocking: a pass another process is running is skipped, not queued). The
thread catches everything a pass raises and never exits on its own; it dies
with the process (the gateway leaves through `os._exit`), and everything it
needs is on disk, so the next process resumes. `stop_poller()` (plugin
unload) stops it. `digest.share` and `village.vote` are meant to register
their own passes here.

Python 3.11, standard library only.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import re
import socket
import stat
import threading
import time
import urllib.parse
from typing import Any, Callable, Optional

try:  # POSIX
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

from ._core import DIR_MODE, FILE_MODE, hermes_home, register_literal_secret

logger = logging.getLogger("av-events")

TRUTHY = frozenset({"1", "true", "yes", "on"})
ENABLED_ENV = "AV_APPROVAL_ENABLED"
URL_ENV = "AV_APPROVAL_URL"
TOKEN_FILE_ENV = "AV_APPROVAL_TOKEN_FILE"
TOKEN_ENV = "AV_APPROVAL_TOKEN"
DAEMON_UID_ENV = "AV_APPROVAL_DAEMON_UID"
DEFAULT_DAEMON_UID = 10001
#: Where the listener table is read. A module attribute, not a variable: only
#: a test replaces it (refuter S2).
PROC_ROOT = "/proc"
POLL_ENV = "AV_APPROVAL_POLL_S"
DEFAULT_POLL_S = 30.0
MIN_POLL_S = 5.0
#: `1` starts the poller in this process whatever it looks like; `0` never.
POLLER_ENV = "AV_APPROVAL_POLLER"

#: Per request. A verb call on the daemon is a local log read and, at most, one
#: append; `wait` is only ever sent with `--timeout 0`.
REQUEST_TIMEOUT_S = 10.0
#: Serve clips each stream at 64 KiB; anything larger is not its answer.
MAX_ANSWER_BYTES = 512 * 1024

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_HOSTNAME = re.compile(r"^[A-Za-z0-9.-]+$")
#: A credential the shim would accept: printable ASCII, no space, quote or backslash.
_TOKEN_OK = re.compile(r'^[\x21-\x7e]+$')


class ApprovalUnavailable(Exception):
    """No usable answer from the daemon (or nothing was sent). `code` says why."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Answer:
    """One verb's answer: the CLI's exit code and the JSON object it printed."""

    __slots__ = ("exit_code", "doc")

    def __init__(self, exit_code: int, doc: dict) -> None:
        self.exit_code = exit_code
        self.doc = doc

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and self.doc.get("ok") is True

    @property
    def error_code(self) -> Optional[str]:
        """The refusal's code (`{"error": {"code": ...}}`), or None."""
        error = self.doc.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        return code if isinstance(code, str) and re.fullmatch(r"[a-z0-9:._-]{1,80}", code) else None

    @property
    def status(self) -> Optional[str]:
        value = self.doc.get("status")
        return value if isinstance(value, str) else None


def _process_env(name: str) -> str:
    """S2: every setting of this module (`AV_APPROVAL_ENABLED`, `_URL`,
    `_DAEMON_UID`, `_TOKEN_FILE`, `_TOKEN`, `_POLL_S`, `_POLLER`) comes from
    the process environment the gateway started with (Hermes loads `.env`
    into it once, at startup), never from the `.env` file the agent can
    rewrite while it runs (`_core.env` re-reads that on every change)."""
    return os.environ.get(name, "").strip()


def enabled() -> bool:
    """`AV_APPROVAL_ENABLED` is on. The URL is checked when a call is made."""
    return _process_env(ENABLED_ENV).lower() in TRUTHY


def configured() -> bool:
    """On, with a URL set (its shape is checked when a call is made)."""
    return enabled() and bool(_process_env(URL_ENV))


# ---- Endpoint -------------------------------------------------------------


class Endpoint:
    __slots__ = ("kind", "host", "port", "path")

    def __init__(self, kind: str, host: str = "", port: int = 0, path: str = "") -> None:
        self.kind = kind  # "unix" | "loopback" | "https"
        self.host = host
        self.port = port
        self.path = path


def parse_endpoint(url: str) -> Optional[Endpoint]:
    """The daemon's address from `AV_APPROVAL_URL`, or None when it is not one
    of the accepted shapes (see the module docstring)."""
    if not url or any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in url):
        return None
    if url.startswith("unix:"):
        path = url[len("unix:"):]
        if not path.startswith("/") or "\x00" in path or "/../" in path + "/" or "/./" in path + "/":
            return None
        return Endpoint("unix", path=path.rstrip("/") or "/")
    if "?" in url or "#" in url:
        return None
    try:
        parts = urllib.parse.urlsplit(url)
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if not hostname or parts.username is not None or parts.password is not None:
        return None
    if parts.path not in ("", "/"):
        return None
    host = hostname.lower()
    if parts.scheme == "http":
        if host not in LOOPBACK_HOSTS or port is None:
            return None
        return Endpoint("loopback", host=host, port=port)
    if parts.scheme == "https":
        if not (_HOSTNAME.fullmatch(hostname) or host == "::1"):
            return None
        return Endpoint("https", host=hostname, port=port or 443)
    return None


# ---- Credential -----------------------------------------------------------


def default_token_file() -> str:
    return os.path.join(hermes_home(), "approval", "agent-token")


def _read_token_file(path: str) -> tuple[Optional[str], Optional[str]]:
    if not path.startswith("/"):
        return None, "token_file_not_absolute"
    # L5: one open that refuses a symlink, then fstat on that very descriptor.
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None, "token_file_missing"
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return None, "token_file_missing"
        if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o600:
            return None, "token_file_mode"
        try:
            raw = os.read(fd, 4096)
        except OSError:
            return None, "token_file_unreadable"
    finally:
        os.close(fd)
    try:
        first = raw.decode("utf-8").split("\n", 1)[0]
    except UnicodeDecodeError:
        return None, "token_file_unreadable"
    token = first.rstrip("\r\n")
    if not token:
        return None, "token_missing"
    return token, None


def agent_token() -> tuple[Optional[str], Optional[str]]:
    """`(token, None)` or `(None, code)`, in the shim's order. Never logged."""
    named = _process_env(TOKEN_FILE_ENV)
    path = named
    if not path:
        default = default_token_file()
        if os.path.lexists(default):
            path = default
    if path:
        token, code = _read_token_file(path)
    else:
        token = _process_env(TOKEN_ENV) or None
        code = None if token else "token_missing"
    if token is None:
        return None, code
    if _TOKEN_OK.fullmatch(token) is None or '"' in token or "\\" in token:
        return None, "token_malformed"
    register_literal_secret(token)
    return token, None


# ---- The listener check ---------------------------------------------------


def process_env(name: str) -> str:
    return _process_env(name)


def daemon_uid() -> Optional[int]:
    raw = _process_env(DAEMON_UID_ENV)
    if not raw:
        return DEFAULT_DAEMON_UID
    return int(raw) if raw.isdigit() else None


def _proc_root() -> str:
    return PROC_ROOT


#: Local addresses a dial of the loopback reaches, as /proc/net/tcp{,6} print
#: them (little-endian hex): 127/8 and 0.0.0.0; ::1, ::, and ::ffff:127/8.
def _reaches_loopback(addr: str) -> bool:
    if len(addr) == 8:
        return addr == "00000000" or addr.endswith("7F")
    if len(addr) == 32:
        return (addr in ("00000000000000000000000000000000", "00000000000000000000000001000000")
                or (addr.startswith("0000000000000000FFFF0000") and addr.endswith("7F")))
    return False


def loopback_listener_ok(port: int, uid: int) -> Optional[str]:
    """None when every loopback-reachable LISTEN socket on `port` is `uid`'s and
    there is at least one; else `facade_listener_foreign`."""
    want = f"{port:04X}"
    seen = False
    readable = False
    for name in ("tcp", "tcp6"):
        path = os.path.join(_proc_root(), "net", name)
        try:
            with open(path, encoding="ascii", errors="replace") as handle:
                lines = handle.read().splitlines()[1:]
        except OSError:
            continue
        readable = True
        for line in lines:
            fields = line.split()
            if len(fields) < 8 or fields[3] != "0A":
                continue
            local = fields[1]
            addr, _, hexport = local.rpartition(":")
            if hexport.upper() != want or not _reaches_loopback(addr.upper()):
                continue
            seen = True
            if fields[7] != str(uid):
                return "facade_listener_foreign"
    if not readable or not seen:
        return "facade_listener_foreign"
    return None


def unix_socket_ok(path: str, uid: int) -> Optional[str]:
    try:
        st = os.lstat(path)
    except OSError:
        return "facade_listener_foreign"
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != uid:
        return "facade_listener_foreign"
    directory = os.path.dirname(path) or "/"
    try:
        dst = os.lstat(directory)
    except OSError:
        return "facade_listener_foreign"
    if not stat.S_ISDIR(dst.st_mode) or dst.st_uid != uid or dst.st_mode & 0o022:
        return "facade_listener_foreign"
    return None


# ---- Transport ------------------------------------------------------------


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:  # noqa: D401 - http.client API
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self._path)
        except BaseException:
            sock.close()
            raise
        self.sock = sock


def _connection(endpoint: Endpoint, timeout: float) -> http.client.HTTPConnection:
    if endpoint.kind == "unix":
        return _UnixConnection(endpoint.path, timeout)
    if endpoint.kind == "loopback":
        return http.client.HTTPConnection(endpoint.host, endpoint.port, timeout=timeout)
    return http.client.HTTPSConnection(endpoint.host, endpoint.port, timeout=timeout)


#: Tests replace this: `(endpoint, path, body bytes, headers) -> (status, body bytes)`.
_transport: Optional[Callable[[Endpoint, str, bytes, dict], tuple[int, bytes]]] = None


def _send(endpoint: Endpoint, path: str, body: bytes, headers: dict) -> tuple[int, bytes]:
    if _transport is not None:
        return _transport(endpoint, path, body, headers)
    conn = _connection(endpoint, REQUEST_TIMEOUT_S)
    try:
        conn.request("POST", path, body=body, headers=headers)
        response = conn.getresponse()
        raw = response.read(MAX_ANSWER_BYTES + 1)
        return response.status, raw
    finally:
        conn.close()


def _first_object(text: Any) -> Optional[dict]:
    if not isinstance(text, str) or not text.strip():
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def call(verb: str, positionals: Optional[list] = None, flags: Optional[dict] = None) -> Answer:
    """One `POST /verb/<verb>`. Raises `ApprovalUnavailable` when nothing was
    sent or no usable answer came back; otherwise the CLI's exit code and the
    JSON object it printed (stdout first, else stderr: a `wait` that is still
    pending prints there)."""
    if not re.fullmatch(r"[a-z_]{1,32}", verb):
        raise ApprovalUnavailable("verb_invalid")
    url = _process_env(URL_ENV)
    endpoint = parse_endpoint(url)
    if endpoint is None:
        raise ApprovalUnavailable("url_refused" if url else "url_missing")
    token, code = agent_token()
    if token is None:
        raise ApprovalUnavailable(code or "token_missing")
    if endpoint.kind in ("loopback", "unix"):
        uid = daemon_uid()
        if uid is None:
            raise ApprovalUnavailable("daemon_uid_invalid")
        problem = (loopback_listener_ok(endpoint.port, uid) if endpoint.kind == "loopback"
                   else unix_socket_ok(endpoint.path, uid))
        if problem is not None:
            raise ApprovalUnavailable(problem)
    body: dict[str, Any] = {}
    if positionals:
        body["positionals"] = list(positionals)
    if flags:
        body["flags"] = dict(flags)
    raw_body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if endpoint.kind == "https":
        headers["X-Approval-Authorization"] = f"Bearer {token}"
    try:
        status, raw = _send(endpoint, f"/verb/{verb}", raw_body, headers)
    except ApprovalUnavailable:
        raise
    except (socket.timeout, TimeoutError):
        raise ApprovalUnavailable("timeout") from None
    except Exception:  # noqa: BLE001 - refused, reset, TLS: no usable answer
        raise ApprovalUnavailable("transport") from None
    if status == 401:
        raise ApprovalUnavailable("unauthorized")
    if status != 200:
        raise ApprovalUnavailable(f"http_{int(status)}")
    if len(raw) > MAX_ANSWER_BYTES:
        raise ApprovalUnavailable("bad_answer")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ApprovalUnavailable("bad_answer") from None
    if not isinstance(parsed, dict):
        raise ApprovalUnavailable("bad_answer")
    exit_code = parsed.get("exit_code")
    if isinstance(exit_code, bool) or not isinstance(exit_code, int):
        raise ApprovalUnavailable("bad_answer")
    if parsed.get("stdout_truncated") is True or parsed.get("stderr_truncated") is True:
        raise ApprovalUnavailable("bad_answer")
    doc = _first_object(parsed.get("stdout")) or _first_object(parsed.get("stderr"))
    if doc is None:
        raise ApprovalUnavailable("bad_answer")
    return Answer(exit_code, doc)


def propose(cls: str, key: str, summary: str, payload_json: str) -> Answer:
    return call("propose", flags={"--class": cls, "--key": key, "--summary": summary,
                                  "--payload-json": payload_json, "--json": True})


def wait(task: str) -> Answer:
    # `--timeout 0` reads the state once; never `--withdraw-on-timeout` beside it.
    return call("wait", positionals=[task], flags={"--timeout": "0", "--json": True})


def start(task: str, key: str, payload_json: str) -> Answer:
    return call("start", positionals=[task], flags={"--action": key, "--payload-json": payload_json,
                                                    "--json": True})


def withdraw(task: str, reason: str) -> Answer:
    return call("withdraw", positionals=[task], flags={"--reason": reason, "--json": True})


# ---- The poller -----------------------------------------------------------

_PASSES: "dict[str, Callable[[bool], None]]" = {}
_contended_logged = False
_PASS_LOCK = threading.Lock()
_POLLER_LOCK = threading.Lock()
_poller: Optional[threading.Thread] = None
_stop = threading.Event()
_wake = threading.Event()
_oneshot: Optional[threading.Thread] = None


def register_pass(name: str, fn: Callable[[bool], None]) -> None:
    """Add a pass the poller runs (`digest.share` and `village.vote` later).
    `fn(execute)`: execute is False for a one-shot resume pass outside the
    gateway, which must stop before it acts (refuter S3)."""
    _PASSES[name] = fn


def poll_interval() -> float:
    raw = _process_env(POLL_ENV)
    try:
        value = float(raw) if raw else DEFAULT_POLL_S
    except ValueError:
        value = DEFAULT_POLL_S
    if value != value:  # NaN
        value = DEFAULT_POLL_S
    return max(MIN_POLL_S, value)


def pass_lock_path() -> str:
    return os.path.join(hermes_home(), "av-events", "approval-pass.lock")


def run_pass(execute: bool = True) -> bool:
    """Run every registered pass once. False when another thread or process
    is running one (skipped, never queued)."""
    global _contended_logged
    if not _PASS_LOCK.acquire(blocking=False):
        return False
    fd: Optional[int] = None
    try:
        try:
            os.makedirs(os.path.dirname(pass_lock_path()), mode=DIR_MODE, exist_ok=True)
            fd = os.open(pass_lock_path(), os.O_RDWR | os.O_CREAT, FILE_MODE)
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if not _contended_logged:
                # L6: one line, until a pass gets the lock again.
                _contended_logged = True
                logger.info("av-events: approval pass_skipped=contended")
            return False
        except OSError as exc:
            logger.warning("av-events: approval pass_lock_failed=%s", type(exc).__name__)
            return False
        _contended_logged = False
        for name, fn in list(_PASSES.items()):
            try:
                fn(execute)
            except Exception as exc:  # noqa: BLE001 - one pass never costs the others
                logger.warning("av-events: approval pass_failed=%s error=%s", name, type(exc).__name__)
        return True
    finally:
        if fd is not None:
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(fd)
        _PASS_LOCK.release()


def _loop(stop: threading.Event, wake: threading.Event) -> None:
    while not stop.is_set():
        try:
            run_pass()
        except BaseException as exc:  # noqa: BLE001 - the thread never ends on its own
            try:
                logger.warning("av-events: approval poller_error=%s", type(exc).__name__)
            except Exception:  # noqa: BLE001
                pass
        try:
            wake.wait(poll_interval())
        except BaseException:  # noqa: BLE001
            time.sleep(MIN_POLL_S)
        wake.clear()


def poller_alive() -> bool:
    return _poller is not None and _poller.is_alive()


def ensure_poller() -> bool:
    """Start the poller thread unless it is running. True when it is running.
    A thread that died is replaced."""
    global _poller, _stop, _wake
    with _POLLER_LOCK:
        if _poller is not None and _poller.is_alive():
            return True
        _stop = threading.Event()
        _wake = threading.Event()
        thread = threading.Thread(target=_loop, args=(_stop, _wake), name="av-events-approval-poller", daemon=True)
        thread.start()
        _poller = thread
        logger.info("av-events: approval poller started")
        return True


def kick() -> None:
    """Run a pass soon, off the caller's thread: wake the poller when it runs,
    else one short-lived thread (at most one at a time) that stops before it
    acts: it proposes and reads answers, and leaves every start to the gateway's
    poller (refuter S3)."""
    global _oneshot
    with _POLLER_LOCK:
        if _poller is not None and _poller.is_alive():
            _wake.set()
            return
        if _oneshot is not None and _oneshot.is_alive():
            return
        _oneshot = threading.Thread(target=run_pass, kwargs={"execute": False}, name="av-events-approval-pass",
                                    daemon=True)
        _oneshot.start()


def stop_poller() -> None:
    """Plugin unload: tell the thread to stop (no join)."""
    global _poller
    with _POLLER_LOCK:
        _stop.set()
        _wake.set()
        _poller = None


__all__ = [
    "Answer",
    "ApprovalUnavailable",
    "Endpoint",
    "agent_token",
    "call",
    "configured",
    "enabled",
    "ensure_poller",
    "kick",
    "parse_endpoint",
    "poller_alive",
    "propose",
    "register_pass",
    "run_pass",
    "start",
    "stop_poller",
    "wait",
    "withdraw",
]
