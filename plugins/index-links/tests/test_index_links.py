"""Pins for the index-links tool-result rewrite.

Tests 1-12 are the pins from the SEREF-OVERLAY refute (findings F2, F3, F4,
N1, N2, N4); the rest pin the patch's own bounds: the size cap, the env off
switch, the tool scope and punctuation trimming.
"""

from __future__ import annotations

import json
import os
import time

import pytest

INDEX_TOOL = "mcp__index__list_opportunities"
OPP = "https://index.network/o/opp1"
OPP_OUT = OPP + "?surface=telegram"
#: Generous so CI under load stays stable; the refute's bound was 0.5 s.
TIME_BOUND_S = 2.0


def hook(plugin, result, tool=INDEX_TOOL):
    return plugin.transform_tool_result(tool_name=tool, args={}, result=result, task_id="t", duration_ms=1)


# --- 1-6: behaviour that held before the patch -----------------------------


def test_01_json_opportunity_url_gains_surface_and_keeps_key_order(plugin):
    raw = json.dumps({"url": OPP, "userUrl": None, "id": "opp1"})
    out = hook(plugin, raw)
    assert out is not None
    assert list(json.loads(out)) == ["url", "userUrl", "id"]
    assert json.loads(out)["url"] == OPP_OUT


def test_02_rewrite_is_idempotent(plugin):
    raw = f"[message Maya]({OPP}) and also {OPP}"
    once = hook(plugin, raw)
    assert once == f"[message Maya]({OPP_OUT}) and also {OPP_OUT}"
    assert hook(plugin, once) is None
    assert once.count("surface=telegram") == 2


@pytest.mark.parametrize(
    "url",
    [
        "https://index.network/o/opp1?action=decline&viewer=v1&sig=s1",
        "https://index.network/o/opp1?action=accept&viewer=v1&sig=s1",
        "https://index.network/o/opp1?surface=x",
    ],
)
def test_03_opportunity_links_with_a_query_unchanged(plugin, url):
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


def test_07_trailing_punctuation_stays_outside_the_query(plugin):
    """F4."""
    assert hook(plugin, f"Tap {OPP}.") == f"Tap {OPP_OUT}."
    assert hook(plugin, f"{OPP}, then") == f"{OPP_OUT}, then"


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


# --- the patch's own bounds ---------------------------------------------------


@pytest.mark.parametrize("value", ["off", "OFF", " off ", "0", "false", "no"])
def test_off_switch_makes_the_hook_a_no_op(plugin, monkeypatch, value):
    monkeypatch.setenv("AV_INDEX_LINKS", value)
    assert hook(plugin, f"Tap {OPP}") is None


@pytest.mark.parametrize("value", ["", "on", "1"])
def test_other_switch_values_keep_the_hook_on(plugin, monkeypatch, value):
    monkeypatch.setenv("AV_INDEX_LINKS", value)
    assert hook(plugin, f"Tap {OPP}") == f"Tap {OPP_OUT}"


def test_off_switch_in_dotenv_works_without_a_restart(plugin, tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text("AV_EVENTS_TOKEN=keep\nAV_INDEX_LINKS=off\n", encoding="utf-8")
    assert hook(plugin, f"Tap {OPP}") is None
    # Flipping it back is seen on the next call (the cache is keyed on mtime).
    dotenv.write_text("AV_EVENTS_TOKEN=keep\nAV_INDEX_LINKS=on\n", encoding="utf-8")

    os.utime(dotenv, ns=(1, 1))
    assert hook(plugin, f"Tap {OPP}") == f"Tap {OPP_OUT}"


def test_off_from_either_source_wins(plugin, tmp_path, monkeypatch):
    """Recheck S1: a blank or 'on' process value cannot override an off in .env, and an off in the
    process env switches it off even when .env says nothing."""
    (tmp_path / ".env").write_text("AV_INDEX_LINKS='off'\n", encoding="utf-8")
    assert hook(plugin, f"Tap {OPP}") is None
    monkeypatch.setenv("AV_INDEX_LINKS", "")
    assert hook(plugin, f"Tap {OPP}") is None
    (tmp_path / ".env").write_text("AV_INDEX_LINKS=on\n", encoding="utf-8")
    import os
    env = tmp_path / ".env"
    os.utime(env, ns=(os.stat(env).st_mtime_ns + 1000, os.stat(env).st_mtime_ns + 1000))
    assert hook(plugin, f"Tap {OPP}") == f"Tap {OPP_OUT}"
    monkeypatch.setenv("AV_INDEX_LINKS", "off")
    assert hook(plugin, f"Tap {OPP}") is None


def test_results_over_256_kib_are_returned_unchanged(plugin):
    filler = "x" * (plugin.MAX_RESULT_BYTES)
    assert hook(plugin, f"{OPP} {filler}") is None
    small = "x" * 1000
    assert hook(plugin, f"{OPP} {small}") == f"{OPP_OUT} {small}"


@pytest.mark.parametrize(
    "tool",
    ["mcp__index__list_opportunities", "mcp_index_get_opportunity", "index_list_opportunities"],
)
def test_index_tool_names_are_in_scope(plugin, tool):
    assert hook(plugin, f"Tap {OPP}", tool=tool) == f"Tap {OPP_OUT}"


@pytest.mark.parametrize(
    "tool",
    [None, "", "terminal", "read_file", "web_extract", "browser_snapshot", "mcp__indexer__list", "tool_call", "my_index_tool"],
)
def test_other_tools_are_out_of_scope(plugin, tool):
    assert hook(plugin, f"Tap {OPP}", tool=tool) is None


@pytest.mark.parametrize("tail", [";", ":", "!", "?", "*", "**", ".)", "’", "”", "..."])
def test_trailing_punctuation_is_kept_after_the_url(plugin, tail):
    assert hook(plugin, f"Tap {OPP}{tail} ok") == f"Tap {OPP_OUT}{tail} ok"


def test_bold_autolink_keeps_its_close(plugin):
    assert hook(plugin, f"**<{OPP}>**") == f"**{OPP_OUT}**"
    assert hook(plugin, f"**{OPP}**") == f"**{OPP_OUT}**"


def test_person_link_at_sentence_end_is_rewritten(plugin):
    assert hook(plugin, "Meet https://index.network/u/abc.") == "Meet https://agents.edgecity.live/rolodex?person=abc."


def test_url_longer_than_the_bound_is_left_whole(plugin):
    url = OPP + "/" + "a" * 3000
    assert hook(plugin, f"Tap {url} ok") is None


def test_register_adds_one_hook(plugin):
    calls = []

    class Ctx:
        def register_hook(self, name, cb):
            calls.append((name, cb))

    plugin.register(Ctx())
    plugin.register(Ctx())
    assert [name for name, _ in calls] == ["transform_tool_result"]


def test_off_switch_dotenv_accepts_export_and_comments(plugin, tmp_path, monkeypatch):
    """Recheck S1: `export KEY=off` and `KEY=off # note` both switch it off."""
    monkeypatch.delenv(plugin.OFF_SWITCH, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    env = tmp_path / ".env"
    env.write_text("export AV_INDEX_LINKS=off\n", encoding="utf-8")
    assert plugin.switched_off() is True
    env.write_text("AV_INDEX_LINKS=off # kill switch\n", encoding="utf-8")
    import os
    os.utime(env, ns=(os.stat(env).st_mtime_ns + 1000, os.stat(env).st_mtime_ns + 1000))
    assert plugin.switched_off() is True
    env.write_text('AV_INDEX_LINKS="off"\n', encoding="utf-8")
    os.utime(env, ns=(os.stat(env).st_mtime_ns + 1000, os.stat(env).st_mtime_ns + 1000))
    assert plugin.switched_off() is True


def test_off_in_dotenv_wins_over_a_stale_on_in_the_process_env(plugin, tmp_path, monkeypatch):
    """Recheck S1: a value Hermes loaded at boot cannot keep the rewrite on."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv(plugin.OFF_SWITCH, "on")
    (tmp_path / ".env").write_text("AV_INDEX_LINKS=off\n", encoding="utf-8")
    assert plugin.switched_off() is True


def test_autolink_lookalike_host_is_left_as_written(plugin):
    """Recheck N1: an autolink on a look-alike host or a port is not an Index URL."""
    for text in ("<https://index.network.evil.com/u/abc>", "<https://index.network@evil.com/u/abc>", "<https://index.network:8443/u/abc>"):
        assert plugin.rewrite_index_links(text) == text
