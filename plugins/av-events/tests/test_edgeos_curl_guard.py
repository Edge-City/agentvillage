"""EDGEOS-CURL-GUARD (BUG 1, 14 Oct): hand-written calls to EdgeOS's directory or /humans/me are refused.

A DM session that began before rc39 re-runs the old §8/§9 bearer curl from its own history; the
bearer is dead, EdgeOS answers 401, and the model tells the resident the directory "expired". The
plugin's `pre_tool_call` now blocks that call and names the script to run. Every near miss passes:
other EdgeOS endpoints, other hosts, the word "directory" in a URL, and the scripts themselves.
"""

from __future__ import annotations

import pytest

POPUP = "00000000-0000-4000-8000-000000000001"
BASE = "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}"

#: Calls the guard must refuse: (tool, command-or-code).
REFUSED = {
    # The old §9 recipe exactly as the skill had it (pre-rc39), continuation and all.
    "old_s9_recipe": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" \\\n'
                      f'  "{BASE}/applications/my/directory/{POPUP}?skip=0&limit=20&q=QUERY"'),
    "old_s9_one_line_jq": ("terminal", f'curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" '
                           f'"{BASE}/applications/my/directory/{POPUP}?limit=100" | jq .results'),
    "old_s8_profile": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" \\\n'
                       f'  "{BASE}/humans/me"'),
    "old_s8_patch": ("terminal", 'curl -s -X PATCH -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" \\\n'
                     '  -H "Content-Type: application/json" \\\n'
                     f'  "{BASE}/humans/me" \\\n  -d \'{{"telegram": "x"}}\''),
    "literal_https": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" '
                      f'https://api.edgeos.world/api/v1/applications/my/directory/{POPUP}'),
    "literal_http_single_quotes": ("terminal", "curl -s -H 'Authorization: Bearer '\"$EDGEOS_BEARER_TOKEN\" "
                                   f"'http://api.edgeos.world/api/v1/humans/me'"),
    "url_first_then_header": ("terminal", f'curl "https://api.edgeos.world/api/v1/humans/me" '
                              '-H "Authorization: Bearer $EDGEOS_BEARER_TOKEN"'),
    "plain_env_base": ("terminal", 'curl -sS -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" '
                       f'"$EDGEOS_API_BASE/applications/my/directory/{POPUP}"'),
    "braced_env_base": ("terminal", f'curl -s "${{EDGEOS_API_BASE}}/humans/me" -H "Authorization: Bearer $EDGEOS_API_KEY"'),
    "own_variable": ("terminal", 'B=https://api.edgeos.world/api/v1; curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" '
                     f'"$B/applications/my/directory/{POPUP}?q=ana"'),
    "own_variable_braced": ("terminal", 'BASE="${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}" && '
                            'curl -s "${BASE}/humans/me" -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN"'),
    "api_key_instead": ("terminal", f'curl -s -H "X-API-Key: $EDGEOS_API_KEY" "{BASE}/applications/my/directory/{POPUP}"'),
    "no_api_v1_prefix": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" https://api.edgeos.world/humans/me'),
    "port_443": ("terminal", 'curl -s https://api.edgeos.world:443/api/v1/humans/me -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN"'),
    "uppercase_host": ("terminal", 'curl -s https://API.EdgeOS.world/api/v1/humans/me'),
    "trailing_slash": ("terminal", f'curl -s "{BASE}/applications/my/directory/"'),
    "absolute_curl_path": ("terminal", f'/usr/bin/curl -s "{BASE}/humans/me"'),
    "after_cd_and": ("terminal", f'cd /tmp && curl -s "{BASE}/humans/me"'),
    "command_substitution": ("terminal", f'R=$(curl -s "{BASE}/humans/me"); echo "$R" | head'),
    "wget": ("terminal", f'wget -qO- --header="Authorization: Bearer $EDGEOS_BEARER_TOKEN" "{BASE}/humans/me"'),
    "httpie": ("terminal", f'http GET "{BASE}/applications/my/directory/{POPUP}" "Authorization:Bearer $EDGEOS_BEARER_TOKEN"'),
    "python_requests": ("terminal", "python3 -c \"import os,requests; print(requests.get('https://api.edgeos.world/api/v1/humans/me', "
                        "headers={'Authorization': 'Bearer ' + os.environ['EDGEOS_BEARER_TOKEN']}).text)\""),
    "python_concat": ("terminal", "python3 -c \"import os,urllib.request as u; b=os.environ['EDGEOS_API_BASE']; "
                      "print(u.urlopen(b + '/humans/me').read())\""),
    "node_fetch": ("terminal", "node -e \"fetch(process.env.EDGEOS_API_BASE + '/applications/my/directory/x').then(r=>r.text()).then(console.log)\""),
    "execute_code_requests": ("execute_code", "import os, requests\n"
                              "r = requests.get(f\"{os.environ['EDGEOS_API_BASE']}/humans/me\", "
                              "headers={'Authorization': 'Bearer ' + os.environ['EDGEOS_BEARER_TOKEN']})\nprint(r.status_code)"),
    "execute_code_fstring": ("execute_code", "base = 'https://api.edgeos.world/api/v1'\nimport urllib.request\n"
                             f"print(urllib.request.urlopen(f'{{base}}/applications/my/directory/{POPUP}').read())"),
    "continuation_inside_url": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" '
                                '"https://api.edgeos.world/api/v1/applications/my/\\\n'
                                f'directory/{POPUP}?q=ana"'),
    # Refute S1 (ov#346): a backtick, `<`, `>` or `.` right after the path is a boundary too.
    "js_template_literal": ("terminal", "node -e \"fetch(`${process.env.EDGEOS_API_BASE}/humans/me`).then(r => r.text())\""),
    "backtick_substitution": ("terminal", "R=`curl -s ${EDGEOS_API_BASE}/humans/me`; echo $R"),
    "redirect_after_path": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" $EDGEOS_API_BASE/humans/me>/tmp/o'),
    "python_str_format": ("terminal", "python3 -c \"import os,requests; print(requests.get('{}/humans/me'.format(os.environ['EDGEOS_API_BASE'])).text)\""),
    "crlf_continuation": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_BEARER_TOKEN" \\\r\n'
                          f'  "{BASE}/humans/me"'),
}

#: Calls the guard must let through.
ALLOWED = {
    # The scripts themselves (they call the control-plane forward).
    "directory_script": ("terminal", "bun skills/edgeos/scripts/directory.ts --search ana"),
    "directory_script_env": ("terminal", "EDGEOS_API_BASE=https://api.edgeos.world/api/v1 bun skills/edgeos/scripts/directory.ts --limit 20"),
    "profile_script": ("terminal", "bun skills/edgeos/scripts/profile.ts"),
    "directory_script_json_jq": ("terminal", "cd ~ && bun skills/edgeos/scripts/directory.ts --json | jq '.[0]'"),
    # The control-plane forward, hand-written (a different host and path).
    "cp_forward": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" '
                   '"$CONTROL_PLANE_URL/tenants/$TENANT_ID/edgeos/directory?search=ana"'),
    # Other EdgeOS endpoints the skill still curls.
    "events_list": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" \\\n'
                    f'  "{BASE}/events/portal/events?popup_id={POPUP}&event_status=published"'),
    "events_search_directory": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" '
                                f'"{BASE}/events/portal/events?popup_id={POPUP}&search=directory"'),
    "events_search_path_in_query": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" '
                                    f'"{BASE}/events/portal/events?search=/humans/me"'),
    "rsvp": ("terminal", 'curl -s -X POST -H "Authorization: Bearer $EDGEOS_API_KEY" \\\n'
             f'  "{BASE}/event-participants/portal/register/{POPUP}"'),
    "participants": ("terminal", 'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" '
                     f'"{BASE}/event-participants/portal/participants?event_id={POPUP}&skip=0&limit=100"'),
    "venues": ("terminal", f'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" "{BASE}/event-venues/portal/venues?popup_id={POPUP}"'),
    "humans_meetings": ("terminal", 'curl -s "${EDGEOS_API_BASE}/humans/meetings"'),
    "directory_script_redirect": ("terminal", "EDGEOS_API_BASE=https://api.edgeos.world/api/v1 bun skills/edgeos/scripts/directory.ts > /tmp/out"),
    "humans_other_path": ("terminal", f'curl -s "{BASE}/humans/mentors"'),
    "applications_other": ("terminal", f'curl -s "{BASE}/applications/my/directory-settings"'),
    # Other hosts, even with the same path.
    "other_host_same_path": ("terminal", "curl -s https://example.com/api/v1/humans/me"),
    "other_host_directory_path": ("terminal", f"curl -s https://example.com/applications/my/directory/{POPUP}"),
    "lookalike_host": ("terminal", 'curl -s "https://api.edgeos.world.example.com/api/v1/humans/me" -H "X: $EDGEOS_API_KEY"'),
    "other_host_with_edgeos_mention": ("terminal", 'curl -s "https://example.com/humans/me"; echo "$EDGEOS_API_BASE"'),
    # The word "directory" in a URL.
    "word_directory_url": ("terminal", "curl -s https://example.com/directory/people"),
    "word_directory_github": ("terminal", "curl -sL https://raw.githubusercontent.com/x/y/main/applications/directory.md"),
    "my_directory_other_host": ("terminal", "wget https://example.org/my/directory/list"),
    # No HTTP client: reading the skill, grepping, echoing.
    "grep_skill": ("terminal", 'grep -n "api.edgeos.world/api/v1/humans/me" skills/edgeos/SKILL.md'),
    "echo_recipe": ("terminal", f'echo "{BASE}/humans/me"'),
    "sed_skill": ("terminal", "sed -n '180,210p' skills/edgeos/SKILL.md | grep -n applications/my/directory"),
    "plain_date": ("terminal", "date -u"),
    # A curl that mentions the path but no EdgeOS reference.
    "no_edgeos_ref": ("terminal", "curl -s localhost:8080/humans/me"),
    "other_var_host_no_edgeos_ref": ("terminal", 'curl -s "$GITHUB_API/humans/me" -H "Authorization: Bearer $GH_TOKEN"'),
    "bare_path_no_edgeos_ref": ("terminal", "python3 -c \"import requests; print(requests.get(base + '/humans/me'))\""),
    # Other tools carrying the same text are not this guard's business.
    "read_file_tool": ("read_file", f'curl "{BASE}/humans/me"'),
    "execute_code_events": ("execute_code", "import os, requests\n"
                            "print(requests.get(os.environ['EDGEOS_API_BASE'] + '/events/portal/events').status_code)"),
}


@pytest.fixture
def guard(plugin):
    import sys
    return sys.modules["hermes_plugins.av_events._edgeos_guard"]


@pytest.fixture
def hooked(plugin, ctx):
    plugin.register(ctx)
    return ctx


def _args(tool, text):
    return {"code": text} if tool == "execute_code" else {"command": text, "background": False}


def fire(ctx, tool, text):
    field = "code" if tool == "execute_code" else "command"
    return ctx.fire("pre_tool_call", tool_name=tool, args={field: text}, session_id="s",
                    task_id="t", tool_call_id="c", turn_id="u")


@pytest.mark.parametrize("name", sorted(REFUSED))
def test_refused(hooked, guard, name):
    tool, text = REFUSED[name]
    results = fire(hooked, tool, text)
    assert results == [{"action": "block", "message": guard.REFUSAL}], name


@pytest.mark.parametrize("name", sorted(ALLOWED))
def test_allowed(hooked, name):
    tool, text = ALLOWED[name]
    results = fire(hooked, tool, text)
    assert all(r.get("action") != "block" for r in results), (name, results)


def test_refusal_names_the_scripts(guard):
    assert "bun skills/edgeos/scripts/directory.ts" in guard.REFUSAL
    assert "bun skills/edgeos/scripts/profile.ts" in guard.REFUSAL
    assert "expired" in guard.REFUSAL  # tells the model not to say it


def test_block_beats_terminal_args_fix(hooked, guard):
    tool, text = REFUSED["old_s9_recipe"]
    results = hooked.fire("pre_tool_call", tool_name="terminal",
                          args={"command": text, "background": False, "heartbeat": 60}, session_id="s")
    assert results == [{"action": "block", "message": guard.REFUSAL}]


def test_terminal_args_fix_still_runs_on_allowed(hooked):
    results = hooked.fire("pre_tool_call", tool_name="terminal",
                          args={"command": "bun skills/edgeos/scripts/directory.ts", "heartbeat": 60}, session_id="s")
    assert results == [{"action": "modify", "args": {"heartbeat": 0}}]


def test_block_beats_an_existing_directive(plugin, guard):
    modify = {"action": "modify", "args": {"timeout": 5}}
    hook = plugin.with_terminal_args_fix(lambda *a, **kw: modify)
    assert hook(tool_name="terminal", args={"command": REFUSED["old_s8_profile"][1]}) == {
        "action": "block", "message": guard.REFUSAL}
    assert hook(tool_name="terminal", args={"command": "ls"}) is modify


@pytest.mark.parametrize("value", ["0", "false", "no", "off", " OFF "])
def test_kill_switch_off(plugin, ctx, monkeypatch, value):
    monkeypatch.setenv("AV_EDGEOS_CURL_GUARD", value)
    plugin.register(ctx)
    assert fire(ctx, *REFUSED["old_s9_recipe"]) == []


@pytest.mark.parametrize("value", ["1", "true", "on", "", "anything"])
def test_kill_switch_on_values(plugin, ctx, monkeypatch, guard, value):
    monkeypatch.setenv("AV_EDGEOS_CURL_GUARD", value)
    plugin.register(ctx)
    assert fire(ctx, *REFUSED["old_s9_recipe"]) == [{"action": "block", "message": guard.REFUSAL}]


def test_runs_with_telemetry_off(plugin, ctx, monkeypatch, guard):
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "pre_tool_call")
    plugin.register(ctx)
    assert fire(ctx, *REFUSED["old_s8_profile"]) == [{"action": "block", "message": guard.REFUSAL}]


def _boom(*_a, **_k):
    raise RuntimeError("matcher broke")


def test_matcher_error_refuses_when_the_endpoint_is_there(guard):
    tool, text = REFUSED["old_s9_recipe"]
    assert guard.safe_directive(tool, _args(tool, text), environ={}, matcher=_boom) == {
        "action": "block", "message": guard.REFUSAL}
    tool, text = REFUSED["old_s8_profile"]
    assert guard.safe_directive(tool, _args(tool, text), environ={}, matcher=_boom) == {
        "action": "block", "message": guard.REFUSAL}


def test_matcher_error_allows_and_logs_otherwise(guard, caplog):
    tool, text = ALLOWED["events_list"]
    with caplog.at_level("WARNING", logger="av-events"):
        assert guard.safe_directive(tool, _args(tool, text), environ={}, matcher=_boom) is None
    assert any("edgeos_curl_guard matcher failed" in r.getMessage() for r in caplog.records)
    assert all("portal" not in r.getMessage() and "Bearer" not in r.getMessage() for r in caplog.records)


def test_matcher_error_in_the_hook_never_raises(plugin, guard, monkeypatch):
    monkeypatch.setattr(guard, "matches", _boom)
    hook = plugin.with_terminal_args_fix(lambda *a, **kw: None)
    assert hook(tool_name="terminal", args={"command": REFUSED["old_s9_recipe"][1]}) == {
        "action": "block", "message": guard.REFUSAL}
    assert hook(tool_name="terminal", args={"command": "date -u"}) is None


@pytest.mark.parametrize("args", [None, "curl", {"command": None}, {"command": 5}, {}, {"cmd": "x"}])
def test_odd_arguments_pass(guard, args):
    assert guard.safe_directive("terminal", args, environ={}) is None


def test_counts():
    assert len(REFUSED) >= 20 and len(ALLOWED) >= 20
