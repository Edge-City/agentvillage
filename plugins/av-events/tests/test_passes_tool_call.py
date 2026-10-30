"""NOT-A-FIT agent read (spec §4 row "(a) box events", §6 item 6): a `terminal` run of the passes script
leaves the box on `tool.call` as hashes and lengths only.

The result is the script's own `--notes` output (the golden file passes.test.ts holds the script to), so
it carries an invented note sentinel and invented names. Whatever the capture mode, the `tool.call`
payload has only `result_hash` and `result_length` of it (README.md:159-161), the label is the free
`skill` / `index-network` (_skill_label.py), and no byte of the note, a name, the command or an argument
leaves.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
GOLDEN = REPO / "skills" / "index-network" / "scripts" / "tests" / "fixtures" / "passes-output-notes.txt"
SESSION = "sess-passes"
COMMAND = "bun skills/index-network/scripts/passes.ts --notes"
NOTE_SENTINEL = "zq-note-sentinel-41f7"
NAMES = ("Testa Sentinel", "Quill Placeholder", "Ortho Fixture")
PAYLOAD_KEYS = {
    "tool_name", "tool_category", "args_hash", "result_hash", "ok", "status", "latency_ms", "receipt",
    "error_type", "operation", "target_system", "category_version", "args_length", "result_length",
}


def keyed(text: str) -> str:
    key = (Path(os.environ["HERMES_HOME"]) / "av-events" / "hash.key").read_text(encoding="ascii").strip()
    return hmac.new(bytes.fromhex(key), text.encode("utf-8", errors="surrogatepass"), hashlib.sha256).hexdigest()


def passes_result() -> str:
    text = GOLDEN.read_text(encoding="utf-8")
    # The golden output is what the pin is about: it holds the note, framed, and the names.
    assert "<their_note>" in text and NOTE_SENTINEL in text
    assert all(name in text for name in NAMES)
    return text


def fire(ctx, result: str, *, workdir: str | None = None) -> None:
    args = {"command": COMMAND}
    if workdir is not None:
        args["workdir"] = workdir
    ctx.fire(
        "post_tool_call",
        session_id=SESSION,
        task_id="task-1",
        turn_id="turn-1",
        tool_name="terminal",
        args=args,
        result=result,
        tool_call_id="call-passes",
        api_request_id="req-1",
        duration_ms=900,
        status="ok",
        error_type=None,
        error_message=None,
    )


def tool_calls(av, plugin):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "tool.call"]


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_a_passes_result_leaves_as_a_hash_and_a_length_only(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="telegram")
    result = passes_result()
    fire(ctx, result, workdir=os.environ["HERMES_HOME"])
    events = tool_calls(av, plugin)
    assert len(events) == 1
    payload = events[0]["payload"]
    assert (payload["tool_name"], payload["target_system"], payload["operation"]) == ("terminal", "skill", "index-network")
    if mode == "metadata":
        assert payload["result_hash"] is None and "result_length" not in payload
        assert set(payload) == PAYLOAD_KEYS - {"args_length", "result_length"}
    else:
        assert set(payload) == PAYLOAD_KEYS
        assert payload["result_hash"] == keyed(result)
        assert payload["result_length"] == len(result)
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR), ensure_ascii=False)
    for leak in (NOTE_SENTINEL, "their_note", *NAMES, "passes.ts", "--notes", "Not what I", "already know"):
        assert leak not in blob, (mode, leak)
