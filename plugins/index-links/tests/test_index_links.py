"""Pins for the index-links tool-result rewrite.

Tests 1-12 are the pins from the SEREF-OVERLAY refute (findings F2, F3, F4,
N1, N2, N4); the rest pin the patch's own bounds: the size cap, the env off
switch, the tool scope and signature-safe punctuation trimming.
"""

from __future__ import annotations

import json
import os
import time

import pytest

INDEX_TOOL = "mcp__index__list_opportunities"
ACCEPT = "https://index.network/o/opp1?action=accept&viewer=v1&sig=s1"
ACCEPT_OUT = ACCEPT + "&surface=telegram"
#: Generous so CI under load stays stable; the refute's bound was 0.5 s.
TIME_BOUND_S = 2.0


def hook(plugin, result, tool=INDEX_TOOL):
    return plugin.transform_tool_result(tool_name=tool, args={}, result=result, task_id="t", duration_ms=1)


# --- 1-6: behaviour that held before the patch -----------------------------


def test_01_json_accept_url_gains_surface_and_keeps_key_order(plugin):
    raw = json.dumps({"acceptUrl": ACCEPT, "userUrl": None, "id": "opp1"})
    out = hook(plugin, raw)
    assert out is not None
    assert list(json.loads(out)) == ["acceptUrl", "userUrl", "id"]
    assert json.loads(out)["acceptUrl"] == ACCEPT_OUT


def test_02_rewrite_is_idempotent(plugin):
    raw = f"[message Maya]({ACCEPT}) and also {ACCEPT}"
    once = hook(plugin, raw)
    assert once == f"[message Maya]({ACCEPT_OUT}) and also {ACCEPT_OUT}"
    assert hook(plugin, once) is None
    assert once.count("surface=telegram") == 2


@pytest.mark.parametrize(
    "url",
    [
        "https://index.network/o/opp1?action=decline&viewer=v1&sig=s1",
        "https://index.network/o/opp1",
        "https://index.network/o/opp1?action=accept&viewer=v1",
    ],
)
def test_03_decline_plain_and_unsigned_opportunity_links_unchanged(plugin, url):
    assert hook(plugin, f"see {url} now") is None


@pytest.mark.parametrize(
    "url",
    [
        "https://index.network.evil.com/u/abc",
        "https://evil-index.network/u/abc",
        "https://index.network@evil.com/u/abc",
        "https://evil.com@index.network/u/abc",
        "https://index.network:443/u/abc",
    ],
)
def test_04_foreign_and_odd_hosts_unchanged(plugin, url):
    assert hook(plugin, f"see {url} now") is None


def test_05_person_signal_and_autolink_go_to_the_portal(plugin):
    assert hook(plugin, "[Maya](https://index.network/u/abc)") == "[Maya](https://agents.edgecity.live/rolodex?person=abc)"
    assert hook(plugin, "https://index.network/i/int9") == "https://agents.edgecity.live/intents?intent=int9"
    assert hook(plugin, "<https://index.network/u/abc>") == "https://agents.edgecity.live/rolodex?person=abc"


@pytest.mark.parametrize("result", [{"url": "https://index.network/u/abc"}, "no links here", None])
def test_06_non_strings_and_linkless_text_unchanged(plugin, result):
    assert hook(plugin, result) is None


# --- 7-11: the refute's failing pins, fixed by this patch --------------------


def test_07_trailing_punctuation_stays_outside_the_signed_query(plugin):
    """F4."""
    assert hook(plugin, f"Tap {ACCEPT}.") == f"Tap {ACCEPT_OUT}."
    assert hook(plugin, f"{ACCEPT}, then") == f"{ACCEPT_OUT}, then"


def test_08_repeated_action_is_not_rewritten(plugin):
    """N1."""
    assert hook(plugin, "https://index.network/o/opp1?action=decline&action=accept&viewer=v1&sig=s1") is None


@pytest.mark.parametrize(
    "raw",
    [
        "index.network " + "[a](" * 25000,  # 100 KB
        "<https://index.network/" * 4400,  # 101 KB
        "index.network " + "[" * 100000,  # 100 KB
        "<https://index.network/" * 40000,  # 920 KB: over the size cap
    ],
    ids=["markdown-open", "autolink-open", "brackets", "autolink-920KB"],
)
def test_09_pathological_results_finish_fast(plugin, raw):
    """F2: each of these took 4 s to 146 s before the patch."""
    start = time.perf_counter()
    hook(plugin, raw)
    assert time.perf_counter() - start < TIME_BOUND_S


def test_10_only_index_tool_results_are_rewritten(plugin):
    """F3."""
    note = "met Maya https://index.network/u/abc123"
    assert hook(plugin, note, tool="read_file") is None
    assert hook(plugin, note, tool="mcp_index_list_opportunities") == "met Maya https://agents.edgecity.live/rolodex?person=abc123"


def test_11_unicode_lookalike_host_is_left_alone_not_deleted(plugin):
    """N4."""
    assert hook(plugin, "index.network; see https://ındex.network/u/abc") is None


def test_12_to_is_dropped_from_an_accept_link(plugin):
    """N2: documents current behaviour. Re-pin once Index says whether `to` is signed."""
    assert hook(plugin, f"{ACCEPT}&to=x") == ACCEPT_OUT


# --- the patch's own bounds ---------------------------------------------------


@pytest.mark.parametrize("value", ["off", "OFF", " off ", "0", "false", "no"])
def test_off_switch_makes_the_hook_a_no_op(plugin, monkeypatch, value):
    monkeypatch.setenv("AV_INDEX_LINKS", value)
    assert hook(plugin, f"Tap {ACCEPT}") is None


@pytest.mark.parametrize("value", ["", "on", "1"])
def test_other_switch_values_keep_the_hook_on(plugin, monkeypatch, value):
    monkeypatch.setenv("AV_INDEX_LINKS", value)
    assert hook(plugin, f"Tap {ACCEPT}") == f"Tap {ACCEPT_OUT}"


def test_off_switch_in_dotenv_works_without_a_restart(plugin, tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text("AV_EVENTS_TOKEN=keep\nAV_INDEX_LINKS=off\n", encoding="utf-8")
    assert hook(plugin, f"Tap {ACCEPT}") is None
    # Flipping it back is seen on the next call (the cache is keyed on mtime).
    dotenv.write_text("AV_EVENTS_TOKEN=keep\nAV_INDEX_LINKS=on\n", encoding="utf-8")

    os.utime(dotenv, ns=(1, 1))
    assert hook(plugin, f"Tap {ACCEPT}") == f"Tap {ACCEPT_OUT}"


def test_process_env_wins_over_dotenv(plugin, tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("AV_INDEX_LINKS='off'\n", encoding="utf-8")
    assert hook(plugin, f"Tap {ACCEPT}") is None
    monkeypatch.setenv("AV_INDEX_LINKS", "")
    assert hook(plugin, f"Tap {ACCEPT}") == f"Tap {ACCEPT_OUT}"


def test_results_over_256_kib_are_returned_unchanged(plugin):
    filler = "x" * (plugin.MAX_RESULT_BYTES)
    assert hook(plugin, f"{ACCEPT} {filler}") is None
    small = "x" * 1000
    assert hook(plugin, f"{ACCEPT} {small}") == f"{ACCEPT_OUT} {small}"


@pytest.mark.parametrize(
    "tool",
    ["mcp__index__list_opportunities", "mcp_index_get_opportunity", "index_list_opportunities"],
)
def test_index_tool_names_are_in_scope(plugin, tool):
    assert hook(plugin, f"Tap {ACCEPT}", tool=tool) == f"Tap {ACCEPT_OUT}"


@pytest.mark.parametrize(
    "tool",
    [None, "", "terminal", "read_file", "web_extract", "browser_snapshot", "mcp__indexer__list", "tool_call", "my_index_tool"],
)
def test_other_tools_are_out_of_scope(plugin, tool):
    assert hook(plugin, f"Tap {ACCEPT}", tool=tool) is None


@pytest.mark.parametrize("tail", [";", ":", "!", "?", "*", "**", ".)", "’", "”", "..."])
def test_trailing_punctuation_is_kept_after_the_url(plugin, tail):
    assert hook(plugin, f"Tap {ACCEPT}{tail} ok") == f"Tap {ACCEPT_OUT}{tail} ok"


def test_bold_autolink_keeps_its_close(plugin):
    assert hook(plugin, f"**<{ACCEPT}>**") == f"**{ACCEPT_OUT}**"
    assert hook(plugin, f"**{ACCEPT}**") == f"**{ACCEPT_OUT}**"


@pytest.mark.parametrize("sig", ["s1_", "s1-", "s1=", "s1=="])
def test_signature_endings_survive(plugin, sig):
    url = f"https://index.network/o/opp1?action=accept&viewer=v1&sig={sig}"
    out = hook(plugin, f"Tap {url}. ok")
    assert out is not None
    assert f"sig={sig.replace('=', '%3D')}&surface=telegram. ok" in out


def test_person_link_at_sentence_end_is_rewritten(plugin):
    assert hook(plugin, "Meet https://index.network/u/abc.") == "Meet https://agents.edgecity.live/rolodex?person=abc."


@pytest.mark.parametrize("key", ["viewer", "sig", "surface", "to"])
def test_any_repeated_signed_key_is_not_rewritten(plugin, key):
    assert hook(plugin, f"{ACCEPT}&{key}=x&{key}=y") is None


def test_url_longer_than_the_bound_is_left_whole(plugin):
    url = ACCEPT + "&pad=" + "a" * 3000
    assert hook(plugin, f"Tap {url} ok") is None


def test_register_adds_one_hook(plugin):
    calls = []

    class Ctx:
        def register_hook(self, name, cb):
            calls.append((name, cb))

    plugin.register(Ctx())
    plugin.register(Ctx())
    assert [name for name, _ in calls] == ["transform_tool_result"]
