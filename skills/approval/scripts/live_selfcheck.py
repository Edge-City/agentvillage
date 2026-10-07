#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Live self-check for the Agent Village approval gate (DATA-43, docs/03 section 3.2 item 6).

Run by `install/install_approval.ts` (and its `--check`) with HERMES'S OWN
INTERPRETER, so every judgement is Hermes's code rather than a second reading
of its config. Modelled on approval-md-hosted `hermes-image/selfcheck.py`
(items 1, 2, 4 and 8), read on 2026-10-01; written for the one-user sandbox
(no launcher, no managed overlay).

    <hermes python> live_selfcheck.py --home <HERMES_HOME> --shim <shim path> --matchers '<JSON list>'

1. Loads `$HERMES_HOME/.env` and `config.yaml` through Hermes's loaders
   (`load_hermes_dotenv`, `load_config`), as `hermes gateway run` does.
2. Reports the states in which Hermes registers no shell hook or replaces the
   hooks block: `HERMES_SAFE_MODE`, `HERMES_MANAGED`, a managed scope
   (`managed_scope.get_managed_dir()`, `/etc/hermes`).
3. Reports the build: `hermes_cli.__version__`, `__release_date__`, and
   whether the fail_closed floor is met (release date 2026.9.21 or later, or a
   git checkout containing main 118984d7 of 2026-09-20).
4. Tests the signal patch BY BEHAVIOUR, as the upstream build step does: a
   `fail_closed` spec whose command is a script running `kill -9 $$` is fired
   through `run_once` and must come back as a block. The patch marker grep is
   reported only as a hint.
4b. The exit-1 probe (DATA-234): a `fail_closed` spec whose command exits 1
   with an empty stdout, fired the same way. Stock Hermes reads no directive
   as an ALLOW (`_evaluate_result`); the checkpoint's widened patch (DATA-228)
   blocks it. Reported as `exit1_blocks` (true, false, or null when the probe
   could not run), never a problem: the shim itself prints a block directive
   and exits 2 on every failure path it can see.
4c. The consent allowlist and its lock (`shell_hooks.allowlist_path()` and the
   `.lock` sibling Hermes opens "a+"): each absent, or a regular file owned by
   this user that it can read (the lock: read and write); an absent lock needs
   a home this user can write. A lock Hermes cannot open makes
   `register_from_config` raise at gateway start, which the gateway swallows:
   no hook registers (`allowlist-unusable:<file>:<why>`, a problem). Whether
   the allowlist already holds the shim's entry is reported, not judged (the
   first gateway start after an install records it). Nothing is written.
5. With Hermes's own parser (`iter_configured_hooks`, config order), checks
   EVERY gated matcher: the FIRST spec for each (matcher, shim) pair is the one
   Hermes registers (later duplicates are dropped), so it must exist and be
   `fail_closed`. Commands and matchers are compared after Python's `strip()`,
   as Hermes's parser and registration key do.
5b. R3 fix round 4 (the trust boundary): from the same parse, what Hermes
   would register for the shim: `routed_entries`, the number of distinct
   matchers among the shim's `pre_tool_call` specs (first spec per matcher,
   as Hermes keeps), and `routed_sha256`, the sha256 of those matchers sorted
   and joined by newlines. The installer prints both on one line, and the
   control plane records only that line from its own exec of the installer.
   An entry added to or removed from config.yaml after an install changes
   them (the installer then reports `live-routed-mismatch`).
6. Fires the shim's `terminal` entry ONCE through the production spawn
   path (`run_once`) with `terminal`, command `ls /tmp` and deliberately NO
   `workdir`. The facade refuses that call above the policy, before the log is
   read, and appends nothing (`hook-unsupported-execution-context`, APRV-415).
   PASS only on a block that came from the facade (exit 2, a block directive
   Hermes parsed as a block, not the shim's own "approval facade unreachable").
   An allow, a shim block, a spawn error or a timeout fails.

Output: one JSON line of FACTS and hard `problems` on stdout; the installer
applies the policy (and the dogfood override). Never prints a credential.
Exit 0 always when it could report; 3 when Hermes's modules are unavailable
(the installer reads that as `selfcheck-live-unavailable`).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile

SIGNAL_PATCH_MARKER = "approval.md patch: signal-killed hook fails closed"
SHIM_BLOCK_PREFIX = "approval facade unreachable"
FLOOR_RELEASE = (2026, 9, 21)
FLOOR_COMMIT = "118984d7"
TRUTHY = {"1", "true", "yes", "on"}


def truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in TRUTHY


def release_tuple(text: str):
    m = re.match(r"^\s*(\d{4})\.(\d{1,2})\.(\d{1,2})", text or "")
    return tuple(int(x) for x in m.groups()) if m else None


def floor_from_git(root: str):
    """True/False when a git checkout answers whether FLOOR_COMMIT is an ancestor of HEAD; None otherwise."""
    if not os.path.isdir(os.path.join(root, ".git")):
        return None
    try:
        r = subprocess.run(["git", "-C", root, "merge-base", "--is-ancestor", FLOOR_COMMIT, "HEAD"],
                           capture_output=True, timeout=20)
    except Exception:  # noqa: BLE001
        return None
    if r.returncode == 0:
        return True
    if r.returncode == 1:
        return False
    return None


def signal_probe(shell_hooks, run_once) -> bool:
    """Fire a fail_closed hook that kills itself with SIGKILL; True only if Hermes blocks the call."""
    try:
        with tempfile.TemporaryDirectory() as scratch:
            hook = os.path.join(scratch, "killed.sh")
            with open(hook, "w", encoding="utf-8") as fh:
                fh.write("#!/bin/sh\ncat >/dev/null\nkill -9 $$\n")
            os.chmod(hook, 0o700)
            spec = shell_hooks.ShellHookSpec(event="pre_tool_call", command=hook, matcher="terminal",
                                             timeout=30, fail_closed=True)
            r = run_once(spec, {"tool_name": "terminal", "args": {"command": "true"},
                                "session_id": "av-approval-signal-probe"})
        parsed = r.get("parsed")
        return isinstance(parsed, dict) and parsed.get("action") == "block"
    except Exception:  # noqa: BLE001 - a probe that cannot run proves nothing
        return False


def exit1_probe(shell_hooks, run_once):
    """Fire a fail_closed hook that exits 1 with no output; True if Hermes blocks, False if it allows, None if unknown."""
    try:
        with tempfile.TemporaryDirectory() as scratch:
            hook = os.path.join(scratch, "exit1.sh")
            with open(hook, "w", encoding="utf-8") as fh:
                fh.write("#!/bin/sh\ncat >/dev/null\nexit 1\n")
            os.chmod(hook, 0o700)
            spec = shell_hooks.ShellHookSpec(event="pre_tool_call", command=hook, matcher="terminal",
                                             timeout=30, fail_closed=True)
            r = run_once(spec, {"tool_name": "terminal", "args": {"command": "true"},
                                "session_id": "av-approval-exit1-probe"})
        if r.get("error") or r.get("timed_out") or r.get("returncode") != 1:
            return None
        parsed = r.get("parsed")
        return isinstance(parsed, dict) and parsed.get("action") == "block"
    except Exception:  # noqa: BLE001 - a probe that cannot run proves nothing
        return None


def allowlist_probe(shell_hooks, home: str, shim: str, problems: list) -> dict:
    """Stat-only facts on the allowlist and its lock; appends `allowlist-unusable:*` problems. Writes nothing."""
    try:
        path = str(shell_hooks.allowlist_path())
        basis = "hermes"
    except Exception:  # noqa: BLE001 - an older build without the helper: Hermes's documented default
        path = os.path.join(home, "shell-hooks-allowlist.json")
        basis = "default"
    out: dict = {"basis": basis}
    uid = os.geteuid()
    for key, p, mode in (("allowlist", path, os.R_OK), ("allowlist_lock", path + ".lock", os.R_OK | os.W_OK)):
        name = os.path.basename(p)
        try:
            st = os.lstat(p)
        except FileNotFoundError:
            parent = os.path.dirname(p) or "."
            if key == "allowlist_lock" and not os.access(parent, os.W_OK | os.X_OK):
                out[key] = "uncreatable"
                problems.append(f"allowlist-unusable:{name}:uncreatable")
            else:
                out[key] = "absent"
            continue
        except OSError:
            out[key] = "unstatable"
            problems.append(f"allowlist-unusable:{name}:unstatable")
            continue
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            why = "not-regular"
        elif st.st_uid != uid:
            why = "wrong-owner"
        elif not os.access(p, mode):
            why = "not-read-write" if mode & os.W_OK else "unreadable"
        else:
            why = ""
        out[key] = why or "ok"
        if why:
            problems.append(f"allowlist-unusable:{name}:{why}")
    try:
        entry = shell_hooks.allowlist_entry_for("pre_tool_call", shim)
        out["shim_recorded"] = entry is not None
    except Exception:  # noqa: BLE001
        out["shim_recorded"] = None
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--home", required=True)
    p.add_argument("--shim", required=True)
    p.add_argument("--matchers", required=True, help="JSON list of the gated matchers")
    a = p.parse_args()
    matchers = json.loads(a.matchers)
    os.environ["HERMES_HOME"] = a.home
    facts: dict = {"check": "av-approval-live-selfcheck", "problems": []}
    problems: list = facts["problems"]

    def done(code: int = 0) -> int:
        print(json.dumps(facts, sort_keys=True))
        return code

    try:
        import hermes_cli
        from hermes_cli.env_loader import load_hermes_dotenv
        from hermes_cli.config import load_config
        from agent import shell_hooks
        run_once = shell_hooks.run_once
        iter_configured_hooks = shell_hooks.iter_configured_hooks
    except Exception as exc:  # noqa: BLE001
        facts["unavailable"] = f"{type(exc).__name__}: {exc}"[:300]
        return done(3)

    try:
        try:
            load_hermes_dotenv(hermes_home=a.home)
        except TypeError:
            load_hermes_dotenv()
        cfg = load_config()
    except Exception as exc:  # noqa: BLE001 - a Hermes that cannot load its config gates nothing
        problems.append(f"hermes-config-unloadable:{type(exc).__name__}")
        return done()

    facts["safe_mode"] = truthy("HERMES_SAFE_MODE")
    facts["managed"] = bool(os.environ.get("HERMES_MANAGED", "").strip())
    managed_dir = None
    try:
        from hermes_cli import managed_scope
        d = managed_scope.get_managed_dir()
        managed_dir = str(d) if d is not None else None
    except Exception:  # noqa: BLE001 - builds without managed scope have none
        managed_dir = None
    facts["managed_dir"] = managed_dir

    facts["version"] = str(getattr(hermes_cli, "__version__", "") or "")
    facts["release_date"] = str(getattr(hermes_cli, "__release_date__", "") or "")
    source = getattr(shell_hooks, "__file__", "") or ""
    root = os.path.dirname(os.path.dirname(os.path.abspath(source))) if source else ""
    rel = release_tuple(facts["release_date"])
    if rel is not None and rel >= FLOOR_RELEASE:
        facts["floor_ok"], facts["floor_basis"] = True, "release_date"
    else:
        git = floor_from_git(root) if root else None
        facts["floor_ok"] = bool(git)
        facts["floor_basis"] = "git" if git is not None else "unknown"
    try:
        with open(source, encoding="utf-8") as fh:
            facts["signal_patch_marker"] = SIGNAL_PATCH_MARKER in fh.read()
    except OSError:
        facts["signal_patch_marker"] = False
    facts["signal_patch"] = signal_probe(shell_hooks, run_once)
    facts["exit1_blocks"] = exit1_probe(shell_hooks, run_once)
    facts["consent_allowlist"] = allowlist_probe(shell_hooks, a.home, a.shim, problems)

    try:
        facts["consent_effective"] = bool(shell_hooks._resolve_effective_accept(cfg, False))
    except Exception:  # noqa: BLE001
        facts["consent_effective"] = None

    specs = [s for s in iter_configured_hooks(cfg)
             if getattr(s, "event", None) == "pre_tool_call" and str(getattr(s, "command", "")).strip() == a.shim]
    # 5b: what Hermes registers for the shim, from this same parse (first spec per matcher).
    routed: list = []
    for s in specs:
        name = str(getattr(s, "matcher", "") or "").strip()
        if name not in routed:
            routed.append(name)
    facts["routed_entries"] = len(routed)
    facts["routed_sha256"] = hashlib.sha256("\n".join(sorted(routed)).encode("utf-8")).hexdigest()
    entries: dict = {}
    for m in matchers:
        # Config order: the first spec for (matcher, command) is the one Hermes registers.
        first = next((s for s in specs if str(getattr(s, "matcher", "") or "").strip() == m), None)
        if first is None:
            problems.append(f"live-entry-missing:{m}")
            continue
        entries[m] = bool(getattr(first, "fail_closed", False) is True)
        if not entries[m]:
            problems.append(f"live-not-fail-closed:{m}")
    facts["entries_fail_closed"] = entries
    terminal = next((s for s in specs if str(getattr(s, "matcher", "") or "").strip() == "terminal"), None)
    if terminal is None or problems:
        return done()
    if facts["safe_mode"] or facts["managed"] or managed_dir:
        # Never fire a hook in a state the installer will refuse anyway.
        return done()

    result = run_once(terminal, {
        "tool_name": "terminal",
        "args": {"command": "ls /tmp"},
        "session_id": "av-approval-selfcheck",
    })
    stdout = (result.get("stdout") or "").strip()
    fire = {"returncode": result.get("returncode"), "timed_out": bool(result.get("timed_out")),
            "spawn_error": bool(result.get("error"))}
    facts["fire"] = fire
    if result.get("error"):
        problems.append("live-hook-not-spawned")
        return done()
    if result.get("timed_out"):
        problems.append("live-hook-timed-out")
        return done()
    directive = None
    if stdout:
        try:
            directive = json.loads(stdout)
        except json.JSONDecodeError:
            directive = None
    parsed = result.get("parsed")
    rc = result.get("returncode")
    if (rc == 2 and isinstance(directive, dict) and directive.get("action") == "block"
            and isinstance(parsed, dict) and parsed.get("action") == "block"):
        message = str(directive.get("message") or "")
        if message.startswith(SHIM_BLOCK_PREFIX):
            fire["verdict"] = "shim-block"
            problems.append("live-facade-unreachable")
        else:
            fire["verdict"] = "facade-block"
            fire["code_matched"] = "hook-unsupported-execution-context" in message
    elif rc == 0 and parsed is None:
        fire["verdict"] = "allow"
        problems.append("live-call-allowed")
    else:
        fire["verdict"] = "unexpected"
        problems.append("live-unexpected-answer")
    return done()


if __name__ == "__main__":
    sys.exit(main())
