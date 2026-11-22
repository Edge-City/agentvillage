"""`propose(..., irreversible=True)` (lead RULED L60017; approval.md APRV-537, `approval propose --irreversible`).

The flag is sent; a core that does not know it is retried ONCE without it, and only on the two refusals the released
core 0.4.8 really gives (read off a real 0.4.8 run, both before anything is written): serve's agent allowlist answers
HTTP 403 `serve-flag-not-permitted` naming the flag, and the CLI answers usage, exit 2, "unknown flag --irreversible".
Every other answer or failure is the caller's, as before, after one call. Without the flag nothing changes.
"""

from __future__ import annotations

import json
import logging
import sys

import pytest

TOKEN = "agent-token-for-the-irreversible-tests-01"
FACADE = "https://approval.example"
TASK = "propose:" + "b" * 32
KEY = "marketplace.app.action:forkicks.order.confirm:fk-draft-0001"
PAYLOAD = '{"appId":"forkicks"}'

# Real approval-md 0.4.8 output (npm integrity sha512-YrAM0K3z..., the boxes' core), byte for byte.
SERVE_403_0_4_8 = ('{"error":{"code":"serve-flag-not-permitted","message":"--irreversible is not accepted on `approval '
                   'propose` from the agent credential, which takes --class, --json, --key, --payload-json, --summary on '
                   'this verb and nothing else. A flag added to it later is refused until somebody decides a harness under '
                   'oversight should have it"},"exit_code":2}')
CLI_STDERR_0_4_8 = '{"error":{"code":"usage","message":"unknown flag --irreversible"}}\n'


def served(exit_code, stdout="", stderr=""):
    return 200, json.dumps({"exit_code": exit_code, "stdout": stdout, "stderr": stderr, "stdout_truncated": False,
                            "stderr_truncated": False}).encode()


def requested(irreversible=True):
    doc = {"ok": True, "task": TASK, "action_key": KEY, "class": "marketplace.app.action", "payload_hash": "0" * 64,
           "decision": "requested", "state": "requested", "seq": 3, "idempotent": False}
    return served(0, json.dumps(doc) + "\n")


def refused_403(code, message):
    return 403, json.dumps({"error": {"code": code, "message": message}, "exit_code": 2}).encode()


def usage(message):
    return served(2, "", json.dumps({"error": {"code": "usage", "message": message}}) + "\n")


class Serve:
    """The `_transport` seam: each request is recorded; the answers are given in order (an exception is raised)."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.sent = []

    def __call__(self, endpoint, path, body, headers):
        self.sent.append((path, json.loads(body)))
        item = self.answers.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    def flags(self):
        return [body.get("flags") for _, body in self.sent]


@pytest.fixture()
def ap(plugin, av, home, monkeypatch):
    monkeypatch.setenv("AV_APPROVAL_ENABLED", "1")
    monkeypatch.setenv("AV_APPROVAL_URL", FACADE)
    monkeypatch.setenv("AV_APPROVAL_TOKEN", TOKEN)
    return sys.modules[f"{av.MODULE_NAME}._approval"]


def use(ap, monkeypatch, *answers):
    serve = Serve(answers)
    monkeypatch.setattr(ap, "_transport", serve)
    return serve


BASE = {"--class": "marketplace.app.action", "--key": KEY, "--summary": "For Kicks order", "--payload-json": PAYLOAD,
        "--json": True}


def propose(ap, **kw):
    return ap.propose("marketplace.app.action", KEY, "For Kicks order", PAYLOAD, **kw)


def test_without_the_flag_the_request_is_byte_for_byte_what_it_was(ap, monkeypatch):
    for kw in ({}, {"irreversible": False}):
        serve = use(ap, monkeypatch, requested())
        assert propose(ap, **kw).doc["decision"] == "requested"
        assert serve.sent == [("/verb/propose", {"flags": BASE})]
        # The exact bytes every other caller (Gold Stars, intent publish, digest share, village vote) sends today.
        assert json.dumps(serve.sent[0][1], ensure_ascii=False, separators=(",", ":")) == (
            '{"flags":{"--class":"marketplace.app.action","--key":"' + KEY + '","--summary":"For Kicks order",'
            '"--payload-json":"{\\"appId\\":\\"forkicks\\"}","--json":true}}')


def test_a_core_that_knows_the_flag_gets_it_once_and_its_answer_is_returned(ap, monkeypatch, caplog):
    serve = use(ap, monkeypatch, requested())
    with caplog.at_level(logging.INFO, logger="av-events"):
        answer = propose(ap, irreversible=True)
    assert (answer.exit_code, answer.doc["decision"], answer.doc["task"]) == (0, "requested", TASK)
    assert serve.flags() == [{**BASE, "--irreversible": True}]
    assert "irreversible=unsupported" not in caplog.text


def test_the_0_4_8_serve_refusal_is_retried_once_without_the_flag(ap, monkeypatch, caplog):
    serve = use(ap, monkeypatch, (403, SERVE_403_0_4_8.encode()), requested())
    with caplog.at_level(logging.INFO, logger="av-events"):
        answer = propose(ap, irreversible=True)
    assert answer.doc["decision"] == "requested"
    assert serve.flags() == [{**BASE, "--irreversible": True}, BASE]
    assert caplog.text.count("av-events: approval propose irreversible=unsupported retried=1") == 1
    assert TOKEN not in caplog.text and PAYLOAD not in caplog.text and "not accepted" not in caplog.text


def test_the_0_4_8_cli_refusal_is_retried_once_without_the_flag(ap, monkeypatch):
    serve = use(ap, monkeypatch, served(2, "", CLI_STDERR_0_4_8), requested())
    answer = propose(ap, irreversible=True)
    assert answer.doc["decision"] == "requested"
    assert serve.flags() == [{**BASE, "--irreversible": True}, BASE]


OTHER_ANSWERS = {
    # exit 2, but not "unknown flag --irreversible"
    "usage_other_flag": usage("unknown flag --bogus"),
    "usage_missing_key": usage("missing --key <key>"),
    "usage_payload": usage("--payload-json must be a JSON object"),
    "usage_message_longer": usage("unknown flag --irreversible-x"),
    "usage_message_prefixed": usage("approval: unknown flag --irreversible"),
    "usage_message_not_a_string": served(2, "", json.dumps({"error": {"code": "usage", "message": None}}) + "\n"),
    # the message, but not usage at exit 2
    "message_with_another_code": served(2, "", json.dumps({"error": {"code": "invalid", "message": "unknown flag --irreversible"}}) + "\n"),
    "message_at_exit_1": served(1, "", CLI_STDERR_0_4_8),
    "message_at_exit_0": served(0, CLI_STDERR_0_4_8),
    "message_at_exit_3": served(3, "", CLI_STDERR_0_4_8),
    # core's other refusals of a propose
    "class_not_requestable": served(1, "", json.dumps({"error": {"code": "class-not-agent-requestable", "message": "x"}}) + "\n"),
    "duplicate_request": served(1, "", json.dumps({"error": {"code": "duplicate-request", "message": "x"}}) + "\n"),
    "autonomous": served(0, json.dumps({"ok": True, "task": TASK, "decision": "autonomous"}) + "\n"),
    # approval.md#681 (a050b8f0, run): the flag on a key first proposed without it that cannot be floored. A STOP,
    # never an unflagged retry on the old key (lead ruling): exit 1, nothing appended.
    "already_decided": served(1, "", json.dumps({"ok": False, "error": {"code": "already-decided", "message": "action ... was proposed without --irreversible and a person has already answered that request (granted at seq 4), so the declaration cannot be recorded for this key and the key is NOT floored. A key keeps what it was first proposed with: propose the irreversible action under a new key. Nothing was appended.", "state": "granted"}}) + "\n"),
    "task_already_registered": served(1, "", json.dumps({"ok": False, "error": {"code": "task-already-registered", "message": "action ... is already registered under task propose:... without --irreversible, and the policy authorizes its class on its own (allow_irreversible), so no request is filed that could record the declaration: the key is NOT floored. A key keeps what it was first proposed with: propose the irreversible action under a new key. Nothing was appended."}}) + "\n"),
}


@pytest.mark.parametrize("name", sorted(OTHER_ANSWERS))
def test_any_other_answer_is_returned_after_one_call_never_retried(ap, monkeypatch, name):
    serve = use(ap, monkeypatch, OTHER_ANSWERS[name], AssertionError("no second call"))
    answer = propose(ap, irreversible=True)
    assert len(serve.sent) == 1 and serve.flags()[0]["--irreversible"] is True
    assert answer.exit_code == json.loads(OTHER_ANSWERS[name][1])["exit_code"]


OTHER_FAILURES = {
    # 403, but another serve refusal, or the flag-refusal code naming another flag or not naming this verb
    "403_other_flag": (refused_403("serve-flag-not-permitted", "--bogus is not accepted on `approval propose` from the agent credential, which takes ..."), "http_403"),
    "403_start_verb": (refused_403("serve-flag-not-permitted", "--irreversible is not accepted on `approval start` from the agent credential, which takes ..."), "http_403"),
    "403_message_first_word_only": (refused_403("serve-flag-not-permitted", "--irreversible"), "http_403"),
    "403_no_message": ((403, b'{"error":{"code":"serve-flag-not-permitted"},"exit_code":2}'), "http_403"),
    "403_path_pinned": (refused_403("serve-path-pinned", "--irreversible is not accepted on `approval propose` from the agent credential,"), "http_403"),
    "403_agent_forbidden": (refused_403("serve-agent-forbidden", "x"), "http_403"),
    "403_tenant_forbidden": (refused_403("serve-tenant-forbidden", "x"), "http_403"),
    "403_not_json": ((403, b"forbidden"), "http_403"),
    "403_empty": ((403, b""), "http_403"),
    "403_error_a_string": ((403, b'{"error":"serve-flag-not-permitted"}'), "http_403"),
    # the 0.4.8 flag-refusal body under another status
    "400_same_body": ((400, SERVE_403_0_4_8.encode()), "http_400"),
    "500_same_body": ((500, SERVE_403_0_4_8.encode()), "http_500"),
    "401": ((401, SERVE_403_0_4_8.encode()), "unauthorized"),
    # no answer at all
    "transport": (ConnectionResetError("reset"), "transport"),
    "timeout": (TimeoutError("slow"), "timeout"),
    "bad_answer": ((200, b"not json"), "bad_answer"),
}


@pytest.mark.parametrize("name", sorted(OTHER_FAILURES))
def test_any_other_failure_raises_after_one_call_never_retried(ap, monkeypatch, name):
    item, code = OTHER_FAILURES[name]
    serve = use(ap, monkeypatch, item, AssertionError("no second call"))
    with pytest.raises(ap.ApprovalUnavailable) as raised:
        propose(ap, irreversible=True)
    assert raised.value.code == code
    assert len(serve.sent) == 1 and serve.flags()[0]["--irreversible"] is True


def test_a_refusal_without_the_flag_is_never_retried(ap, monkeypatch):
    for item in (served(2, "", CLI_STDERR_0_4_8), (403, SERVE_403_0_4_8.encode())):
        serve = use(ap, monkeypatch, item, AssertionError("no second call"))
        try:
            propose(ap)
        except ap.ApprovalUnavailable as error:
            assert error.code == "http_403"
        assert serve.flags() == [BASE]


SECOND = {
    "second_raises_transport": (ConnectionResetError("reset"), "transport"),
    "second_403_again": ((403, SERVE_403_0_4_8.encode()), "http_403"),
    "second_500": ((500, b"{}"), "http_500"),
}


@pytest.mark.parametrize("first", ["serve", "cli"])
@pytest.mark.parametrize("name", sorted(SECOND))
def test_a_failure_of_the_retry_is_the_callers_and_there_is_no_third_call(ap, monkeypatch, first, name):
    refusal = (403, SERVE_403_0_4_8.encode()) if first == "serve" else served(2, "", CLI_STDERR_0_4_8)
    item, code = SECOND[name]
    serve = use(ap, monkeypatch, refusal, item, AssertionError("no third call"))
    with pytest.raises(ap.ApprovalUnavailable) as raised:
        propose(ap, irreversible=True)
    assert raised.value.code == code
    assert serve.flags() == [{**BASE, "--irreversible": True}, BASE]


@pytest.mark.parametrize("first", ["serve", "cli"])
def test_a_retry_answered_with_the_refusal_again_is_returned_as_is(ap, monkeypatch, first):
    refusal = (403, SERVE_403_0_4_8.encode()) if first == "serve" else served(2, "", CLI_STDERR_0_4_8)
    for retry in (served(2, "", CLI_STDERR_0_4_8), served(1, "", json.dumps({"error": {"code": "x"}}) + "\n"),
                  served(0, json.dumps({"ok": True, "task": TASK, "decision": "autonomous"}) + "\n")):
        serve = use(ap, monkeypatch, refusal, retry, AssertionError("no third call"))
        answer = propose(ap, irreversible=True)
        assert answer.exit_code == json.loads(retry[1])["exit_code"]
        assert len(serve.sent) == 2


def test_serve_refusals_keep_their_code_and_message_on_the_error(ap, monkeypatch):
    use(ap, monkeypatch, (403, SERVE_403_0_4_8.encode()))
    with pytest.raises(ap.ApprovalUnavailable) as raised:
        ap.call("propose", flags={"--irreversible": True})
    assert str(raised.value) == "http_403" and raised.value.code == "http_403"
    assert raised.value.refusal_code == "serve-flag-not-permitted"
    assert raised.value.refusal_message.startswith("--irreversible is not accepted on `approval propose`")
    for body in (b"", b"[]", b'{"error":{"code":"BAD CODE","message":7}}', b"\xff"):
        use(ap, monkeypatch, (403, body))
        with pytest.raises(ap.ApprovalUnavailable) as raised:
            ap.call("propose", flags={})
        assert (raised.value.code, raised.value.refusal_code, raised.value.refusal_message) == ("http_403", None, None)
