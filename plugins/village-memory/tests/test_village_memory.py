"""village-memory (D3): the provider's block, its two tools, fail-open reads, caps and visible text.

Hermes is not imported (see conftest.py); `test_village_memory_hermes.py` covers Hermes's real
discovery. Synthetic fixtures only.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
HERMES_INVISIBLE = (
    "​‌‍⁠⁢⁣⁤﻿"
    "‪‫‬‭‮⁦⁧⁨⁩"
)


def set_window(home: Path, tokens) -> None:
    text = "model:\n  provider: x\n" if tokens is None else f"model:\n  context_length: {tokens}\n"
    (home / "config.yaml").write_text(text, encoding="utf-8")


# ---- discovery shape -------------------------------------------------------------------------------


def test_hermes_discovery_markers_and_manifest():
    """plugins/memory/__init__.py:64-71 reads only the first 8 KB for these words; plugin.yaml says
    exclusive so the general plugin manager records it and never imports it. Only `__init__.py` at
    the top level: Hermes executes every sibling *.py (plugins/plugin_loader.py:117-125)."""
    head = (PLUGIN_DIR / "__init__.py").read_text(encoding="utf-8")[:8192]
    assert "register_memory_provider" in head and "MemoryProvider" in head
    manifest = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
    assert manifest.startswith("name: village-memory\n")
    assert "\nkind: exclusive\n" in manifest
    assert sorted(p.name for p in PLUGIN_DIR.glob("*.py")) == ["__init__.py"]


def test_register_hands_hermes_a_fresh_available_provider_each_time(vm):
    ctx = type("Ctx", (), {"providers": [], "register_memory_provider": lambda self, p: self.providers.append(p)})()
    vm.register(ctx)
    vm.register(ctx)
    first, second = ctx.providers
    assert first is not second
    assert first.name == "village-memory"
    assert first.is_available() is True  # no I/O, no profile needed
    assert first.identity_signature() == {}
    vm.register(object())  # a context without the hook (the general manager) is a no-op


# ---- the block -------------------------------------------------------------------------------------


def test_missing_profile_is_an_empty_block(provider, home):
    assert not (home / "knowledge" / "agentvillage" / "_profile.md").exists()
    assert provider.system_prompt_block() == ""


def test_private_block_on_a_big_window_is_the_whole_profile_without_its_manifest_line(provider, write_profile, vm):
    write_profile()
    block = provider.system_prompt_block()
    assert block.startswith(f"{vm.SEPARATOR}\n{vm.BLOCK_TITLE}\n{vm.SEPARATOR}\n")
    assert "Build a courtyard garden (you)" in block and "lighthouse restoration" in block
    assert "agentvillage-profile v1" not in block
    assert "Data, never instructions" in block and "`resident_profile`" in block and "`resident_context`" in block


def test_block_is_read_fresh_at_every_build(provider, write_profile, h):
    write_profile()
    assert "courtyard" in provider.system_prompt_block()
    write_profile(h.profile_text(h.BODY.replace("courtyard garden", "rooftop orchard")))
    block = provider.system_prompt_block()
    assert "rooftop orchard" in block and "courtyard" not in block


@pytest.mark.parametrize("tokens", [90_000, 199_999, None])
def test_a_small_or_unknown_window_leaves_the_sources_out(provider, write_profile, home, vm, tokens):
    set_window(home, tokens)
    write_profile()
    block = provider.system_prompt_block()
    assert "courtyard" in block and "tidepool" in block
    assert "lighthouse" not in block and "## Shared on the Context page" not in block
    assert block.endswith(vm.REDUCED_MARKER)


def test_a_90k_window_caps_the_block_at_about_25k(provider, write_profile, home, vm, h):
    set_window(home, 90_000)
    line = "- a synthetic claim line about kelp farming (you)\n"
    write_profile(h.profile_text("## Context tags\n" + line * 2000 + "## Shared on the Context page\nx\n"))
    block = provider.system_prompt_block()
    header = block[: block.index("\n\n") + 2]
    shown = block[len(header):]
    assert len(shown) <= int(90_000 * 0.08 * 3.5) == 25_200
    assert shown.endswith(f"\n{vm.CUT_MARKER}") and shown[: -len(vm.CUT_MARKER) - 1].endswith("(you)")


def test_block_budget(vm):
    assert vm.block_budget(1_000_000, True) == (True, 80_000)
    assert vm.block_budget(200_000, True) == (True, 80_000)
    assert vm.block_budget(1_000_000, False) == (False, 80_000)
    assert vm.block_budget(90_000, True) == (False, 25_200)
    assert vm.block_budget(None, True) == (False, 25_200)
    assert vm.block_budget(10_000, True) == (False, 2_800)


def test_body_over_80k_is_cut_at_a_line_end(provider, write_profile, vm, h):
    line = "- a synthetic claim line about kelp farming (you)\n"
    write_profile(h.profile_text("## Context tags\n" + line * 3000))  # ~150K code points, under 400,000 bytes
    block = provider.system_prompt_block()
    shown = block[block.index("\n\n") + 2:]
    assert len(shown) <= vm.BLOCK_MAX_CHARS
    assert shown.endswith(f"\n{vm.CUT_MARKER}") and shown[: -len(vm.CUT_MARKER) - 1].endswith("(you)")


def test_body_at_the_cap_is_not_cut(provider, write_profile, vm, h):
    write_profile(h.profile_text("x" * (vm.BLOCK_MAX_CHARS - 1) + "\n"))
    assert vm.CUT_MARKER not in provider.system_prompt_block()


def test_a_later_manifest_version_still_loads_its_body(provider, write_profile, h):
    write_profile(f"<!-- agentvillage-profile v2 sha256=abc newfield=1 -->\n{h.BODY}")
    block = provider.system_prompt_block()
    assert "courtyard" in block and "agentvillage-profile" not in block


def test_no_manifest_line_loads_the_file_as_text(provider, write_profile, h):
    write_profile(h.BODY)
    assert "courtyard" in provider.system_prompt_block()


def test_sha_mismatch_is_logged_by_code_and_the_body_used(provider, write_profile, caplog, h):
    write_profile(f"{h.manifest_line(h.BODY, sha='0' * 64)}\n{h.BODY}")
    with caplog.at_level(logging.DEBUG, logger="village-memory"):
        block = provider.system_prompt_block()
    assert "courtyard" in block
    assert "profile_sha_mismatch" in caplog.text
    assert "courtyard" not in caplog.text and "tidepool" not in caplog.text


def test_sha_is_verified_over_the_body_bytes(vm, write_profile, home):
    write_profile()
    profile = vm.read_profile(home)
    assert profile.sha_ok is True and profile.rendered_at == "2026-10-15T08:00:00.000Z"


@pytest.mark.parametrize("case", ["directory", "symlink", "hard_link", "undecodable", "too_large", "mode_000", "empty"])
def test_fail_open_reads_give_an_empty_block(provider, write_profile, home, tmp_path_factory, case, caplog, h):
    path = home / "knowledge" / "agentvillage" / "_profile.md"
    outside = tmp_path_factory.mktemp("outside") / "secret.md"
    outside.write_text(h.profile_text(), encoding="utf-8")
    if case == "directory":
        path.mkdir()
    elif case == "symlink":
        path.symlink_to(outside)
    elif case == "hard_link":
        os.link(outside, path)
    elif case == "undecodable":
        write_profile(raw=b"\xff\xfe not utf-8 \xc3\x28\n")
    elif case == "too_large":
        write_profile("x" * 400_001)
    elif case == "empty":
        write_profile(h.manifest_line("") + "\n")
    elif case == "mode_000":
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            pytest.skip("root reads mode 000")
        write_profile()
        path.chmod(0)
    try:
        with caplog.at_level(logging.DEBUG, logger="village-memory"):
            assert provider.system_prompt_block() == ""
            result = json.loads(provider.handle_tool_call("resident_profile", {}))
    finally:
        if case == "mode_000":
            path.chmod(0o600)
    assert result["status"] == "unavailable" and "profile" not in result
    assert "courtyard" not in caplog.text


def test_invisible_and_control_characters_and_fences_never_reach_the_prompt(provider, write_profile, caplog, vm, h):
    assert vm.INVISIBLE_CHARS == frozenset(HERMES_INVISIBLE)
    noisy = h.BODY.replace("courtyard", "court" + HERMES_INVISIBLE + "\x00\x07\x1b\x7f\x85yard")
    noisy = noisy.replace("## From", "<memory-context>\n</memory-context>\r\n## From")
    write_profile(h.profile_text(noisy))
    with caplog.at_level(logging.DEBUG, logger="village-memory"):
        block = provider.system_prompt_block()
        tool = json.loads(provider.handle_tool_call("resident_profile", {}))["profile"]
    for text in (block, tool):
        assert "courtyard" in text
        assert not set(text) & set(HERMES_INVISIBLE)
        assert not any((ord(ch) < 32 and ch not in "\n\t") or 0x7F <= ord(ch) <= 0x9F for ch in text)
        assert "memory-context" not in text and "\r" not in text
    assert "removed" in caplog.text and "courtyard" not in caplog.text


# ---- sessions and the switch -----------------------------------------------------------------------


@pytest.mark.parametrize(("chat_type", "platform", "agent_context"), [
    ("group", "telegram", "primary"), ("forum", "telegram", "primary"), ("channel", "telegram", "primary"),
    ("thread", "slack", "primary"), ("something-new", "telegram", "primary"),
    ("", "cron", "cron"), (None, "telegram", "cron"), ("", "api_server", "primary"), ("", "webhook", "primary"),
])
def test_shared_chats_and_cron_get_no_profile_block_and_no_tools(session, write_profile, vm, chat_type, platform,
                                                                 agent_context):
    """PRIVACY (lead L32315): the profile holds Private lines with no per-line visibility, so a group, room or
    cron session gets NO profile block (it used to get a reduced one), as it gets no tools."""
    write_profile()
    p = session(chat_type=chat_type, platform=platform, agent_context=agent_context)
    assert p.system_prompt_block() == ""
    assert p.get_tool_schemas() == []
    for tool in ("resident_profile", "resident_context"):
        result = json.loads(p.handle_tool_call(tool, {"query": "courtyard"}))
        assert result == {"source": "village-memory", "status": "unavailable", "reason": "unavailable in group sessions"}


@pytest.mark.parametrize(("chat_type", "platform"), [("dm", "telegram"), ("private", "telegram"), ("", "cli"),
                                                     (None, "tui"), ("", None)])
def test_private_sessions_get_everything(session, write_profile, chat_type, platform):
    write_profile()
    p = session(chat_type=chat_type, platform=platform)
    assert "lighthouse" in p.system_prompt_block()
    assert [s["name"] for s in p.get_tool_schemas()] == ["resident_context", "resident_profile"]


def test_tool_names_are_routed_before_initialize(vm):
    """Hermes reads schemas at add_provider, before initialize (memory_manager.py:363-405)."""
    assert len(vm.VillageMemoryProvider().get_tool_schemas()) == 2


@pytest.mark.parametrize("value", ["0", "false", "No", " off "])
def test_switch_off_in_env_or_dotenv(provider, write_profile, home, monkeypatch, value):
    write_profile()
    monkeypatch.setenv("AV_VILLAGE_MEMORY", value)
    assert provider.system_prompt_block() == ""
    assert json.loads(provider.handle_tool_call("resident_profile", {}))["status"] == "unavailable"
    assert provider.is_available() is True  # Hermes's gate stays config-only
    monkeypatch.delenv("AV_VILLAGE_MEMORY")
    (home / ".env").write_text(f"AV_VILLAGE_MEMORY={value.strip()}  # flipped by the cp\n", encoding="utf-8")
    assert provider.system_prompt_block() == ""
    (home / ".env").write_text("AV_VILLAGE_MEMORY=1\n", encoding="utf-8")
    assert "courtyard" in provider.system_prompt_block()


def test_prefetch_is_empty_and_memory_writes_are_ignored(provider, write_profile):
    write_profile()
    assert provider.prefetch("tell me about the courtyard") == ""
    assert provider.on_memory_write("add", "user", "anything", {"session_id": "s1"}) is None
    assert provider.sync_turn("u", "a") is None


# ---- tool schemas ----------------------------------------------------------------------------------


def test_tool_schemas_are_valid_function_schemas(provider):
    schemas = provider.get_tool_schemas()
    assert [s["name"] for s in schemas] == ["resident_context", "resident_profile"]
    for schema in schemas:
        assert set(schema) == {"name", "description", "parameters"}
        assert schema["name"].isidentifier() and len(schema["name"]) <= 64
        assert isinstance(schema["description"], str) and 40 < len(schema["description"]) < 1024
        params = schema["parameters"]
        assert params["type"] == "object" and isinstance(params["properties"], dict)
        assert set(params["required"]) <= set(params["properties"])
        json.dumps(schema)
    context = schemas[0]
    assert context["parameters"]["properties"]["query"]["type"] == "string"
    assert context["parameters"]["required"] == ["query"]


def test_tool_results_are_json_objects_naming_the_source(provider, write_profile):
    write_profile()
    for tool, args in (("resident_profile", {}), ("resident_context", {"query": ""}),
                       ("resident_context", {"query": "aquaponics"}), ("nope", {})):
        result = json.loads(provider.handle_tool_call(tool, args))
        assert result["source"] == "village-memory" and "status" in result


# ---- resident_profile ------------------------------------------------------------------------------


def test_resident_profile_rereads_after_the_file_changes(provider, write_profile, h):
    assert json.loads(provider.handle_tool_call("resident_profile", {}))["status"] == "unavailable"
    write_profile()
    first = json.loads(provider.handle_tool_call("resident_profile", {}))
    assert first["status"] == "ok" and "courtyard garden" in first["profile"]
    assert first["rendered_at"] == "2026-10-15T08:00:00.000Z"
    write_profile(h.profile_text(h.BODY.replace("courtyard garden", "rooftop orchard")))
    second = json.loads(provider.handle_tool_call("resident_profile", {}))
    assert "rooftop orchard" in second["profile"] and "courtyard" not in second["profile"]


def test_resident_profile_has_the_blocks_caps(provider, write_profile, home):
    set_window(home, 90_000)
    write_profile()
    profile = json.loads(provider.handle_tool_call("resident_profile", {}))["profile"]
    assert "courtyard" in profile and "lighthouse" not in profile


# ---- resident_context ------------------------------------------------------------------------------


def test_resident_context_finds_fixture_sources(provider, write_profile, home):
    write_profile()
    cv = json.loads(provider.handle_tool_call("resident_context", {"query": "aquaponics"}))
    assert cv["status"] == "ok" and cv["match"] == "all"
    assert [hit["ref"] for hit in cv["hits"]] == ["knowledge/agentvillage/upload-1758100000000.md:13"]
    assert set(cv["hits"][0]) == {"ref", "snippet", "score"} and "aquaponics" in cv["hits"][0]["snippet"]
    books = json.loads(provider.handle_tool_call("resident_context", {"query": "Seeing like a State"}))
    assert books["hits"][0]["ref"].startswith("knowledge/agentvillage/note-1758000000000.md:")
    profile = json.loads(provider.handle_tool_call("resident_context", {"query": "tidepool robotics"}))
    assert [hit["ref"] for hit in profile["hits"]] == ["knowledge/agentvillage/_profile.md:13-14"]  # file lines (line 1 is the manifest)
    assert json.loads(provider.handle_tool_call("resident_context", {"query": "zzqx"}))["hit_count"] == 0
    # The manifest line and other _-files are not searched.
    assert json.loads(provider.handle_tool_call("resident_context", {"query": "sha256"}))["hit_count"] == 0
    assert json.loads(provider.handle_tool_call("resident_context", {"query": "skippedsecret"}))["hit_count"] == 0
    assert not (home / ".recall").exists()  # no index, nothing written


def test_resident_context_any_term_fallback_and_prefix_match(provider):
    any_term = json.loads(provider.handle_tool_call("resident_context", {"query": "aquaponics legibility"}))
    assert any_term["match"] == "any" and any_term["hit_count"] == 2
    prefix = json.loads(provider.handle_tool_call("resident_context", {"query": "control"}))  # controllers
    assert prefix["hit_count"] == 1


def test_resident_context_skips_linked_and_oversized_files(provider, home, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    (outside / "a.md").write_text("linkedsecretword\n", encoding="utf-8")
    (outside / "b.md").write_text("hardlinkedsecretword\n", encoding="utf-8")
    base = home / "knowledge" / "agentvillage"
    (base / "linked.md").symlink_to(outside / "a.md")
    os.link(outside / "b.md", base / "hard.md")
    (base / "huge.md").write_text("hugesecretword " * 200_000, encoding="utf-8")
    for word in ("linkedsecretword", "hardlinkedsecretword", "hugesecretword"):
        assert json.loads(provider.handle_tool_call("resident_context", {"query": word}))["hit_count"] == 0


def test_resident_context_snippets_are_visible_and_capped(provider, home, vm):
    base = home / "knowledge" / "agentvillage"
    (base / "note-noisy.md").write_text("kelp" + HERMES_INVISIBLE + " farming notes\n", encoding="utf-8")
    (base / "note-long.md").write_text(("filler words " * 60) + "seaweed " + ("more words " * 60) + "\n", encoding="utf-8")
    noisy = json.loads(provider.handle_tool_call("resident_context", {"query": "farming"}))
    assert noisy["hits"] and not set(noisy["hits"][0]["snippet"]) & set(HERMES_INVISIBLE)
    long = json.loads(provider.handle_tool_call("resident_context", {"query": "seaweed"}))
    snippet = long["hits"][0]["snippet"]
    assert "seaweed" in snippet and len(snippet) <= vm.SNIPPET_CHARS + 2


def test_resident_context_without_a_knowledge_dir_finds_nothing(provider, home):
    import shutil

    shutil.rmtree(home / "knowledge")
    result = json.loads(provider.handle_tool_call("resident_context", {"query": "aquaponics"}))
    assert result["status"] == "ok" and result["hit_count"] == 0


@pytest.mark.parametrize(("args", "reason"), [({}, "empty_query"), ({"query": "  "}, "empty_query"),
                                              ({"query": 5}, "empty_query"), ({"query": "x" * 501}, "query_too_long")])
def test_resident_context_rejects_bad_queries(provider, args, reason):
    result = json.loads(provider.handle_tool_call("resident_context", args))
    assert result["status"] == "error" and result["reason"] == reason and result["hits"] == []


def test_handle_tool_call_and_the_block_never_raise(provider, monkeypatch, vm):
    monkeypatch.setattr(vm, "read_profile", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    result = json.loads(provider.handle_tool_call("resident_profile", {}))
    assert result["status"] == "error" and result["reason"] == "internal_RuntimeError"
    assert provider.system_prompt_block() == ""


def test_profile_path_is_the_providers_home(provider, home):
    assert provider.profile_path() == Path(home) / "knowledge" / "agentvillage" / "_profile.md"


# ---- review folds (ov#359 refute S1 wording, S3 safe reader) -------------------------------------


def test_no_profile_answer_is_plain_and_points_at_user_md(provider, write_profile):
    for setup in ("absent", "empty"):
        if setup == "empty":
            write_profile("\n")
        result = json.loads(provider.handle_tool_call("resident_profile", {}))
        assert result["status"] == "unavailable" and result["reason"] == "no_profile"
        assert result["say"] == "No saved context profile is available for them yet. Use memories/USER.md and this conversation, or ask them."
        assert "rendered" not in json.dumps(result)


def test_descriptions_never_promise_a_block(provider):
    for schema in provider.get_tool_schemas():
        text = schema["description"]
        assert "Your system prompt holds" not in text
    profile = next(s for s in provider.get_tool_schemas() if s["name"] == "resident_profile")["description"]
    assert "when there is one" in profile and "memories/USER.md" in profile and "ask them" in profile


@pytest.mark.parametrize("case", ["absent", "fifo", "symlink", "directory", "ok"])
def test_profile_digest_never_blocks_or_follows(provider, home, write_profile, tmp_path_factory, case):
    import hashlib

    path = home / "knowledge" / "agentvillage" / "_profile.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    if case == "fifo":
        os.mkfifo(path)
    elif case == "symlink":
        target = tmp_path_factory.mktemp("o") / "x.md"
        target.write_text("x\n", encoding="utf-8")
        path.symlink_to(target)
    elif case == "directory":
        path.mkdir()
    elif case == "ok":
        write_profile("## Context tags\n")
    digest = provider.profile_digest()
    expected = {"absent": "-", "fifo": "?not_a_regular_file", "symlink": "?symlink", "directory": "?not_a_regular_file",
                "ok": hashlib.sha256(b"## Context tags\n").hexdigest()}[case]
    assert digest == expected
