"""ODIN-ASK FINDABLE: a model can find `ask_odin` through Hermes's `tool_search`.

The equivalent of `test_ask_village_findable.py` for `ask_odin`: Hermes defers plugin tools,
so the model finds `ask_odin` with `tool_search` first. `search_catalog` and the tokeniser are
that file's mirror of Hermes's `tools/tool_search_catalog.py` (loaded from it, not copied), and
the catalog is built the same way: every av-events module with a `TOOL_SCHEMA`, village-bridge's
`village`, and Hermes's `session_search`. That file's own tests run over the same catalog, which
now holds `ask_odin`, so they also prove `ask_odin` takes no village-group or people query away.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_FINDABLE = Path(__file__).resolve().with_name("test_ask_village_findable.py")
_spec = importlib.util.spec_from_file_location("askodin_findable_mirror", _FINDABLE)
mirror = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mirror)

search_catalog = mirror.search_catalog
_tokenize = mirror._tokenize

#: Typical tool_search queries for "ask ODIN / the constitution". Each must admit ask_odin and rank it first.
ODIN_QUERIES = (
    "ask odin",
    "odin",
    "ask_odin",
    "constitution",
    "village constitution",
    "constitution question",
    "explain a ruling",
    "constitution ruling",
    "explain constitution clause",
    "propose a rule",
    "proposed rule",
    "check a proposed rule",
    "constitution agent",
)


@pytest.fixture()
def catalog(plugin, av) -> dict[str, list[str]]:
    """As `test_ask_village_findable.catalog`: the plugin's tools plus `village` and `session_search`."""
    entries: dict[str, list[str]] = {}
    for mod_name, module in sorted(sys.modules.items()):
        schema = getattr(module, "TOOL_SCHEMA", None) if mod_name.startswith(f"{av.MODULE_NAME}.") else None
        if isinstance(schema, dict) and schema.get("name"):
            toolset = getattr(module, "TOOLSET", "") or ""
            params = (schema.get("parameters") or {}).get("properties") or {}
            entries[schema["name"]] = _tokenize(mirror._search_text(schema["name"], toolset,
                                                                    schema.get("description", ""), params))
    spec = importlib.util.spec_from_file_location("askodin_village_bridge", mirror.VILLAGE_BRIDGE)
    bridge = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = bridge
    try:
        spec.loader.exec_module(bridge)
    finally:
        sys.modules.pop(spec.name, None)
        sys.modules.pop(f"{spec.name}._mini_apps", None)
    vschema = bridge.SCHEMA
    entries[vschema["name"]] = _tokenize(mirror._search_text(vschema["name"], "village", vschema["description"],
                                                             vschema["parameters"]["properties"]))
    entries["session_search"] = _tokenize(mirror._search_text("session_search", "session_search",
                                                              mirror.SESSION_SEARCH_DESCRIPTION,
                                                              mirror.SESSION_SEARCH_PARAMS))
    assert {"ask_odin", "ask_village", "pray", "village"} <= set(entries)
    return entries


@pytest.fixture()
def odin_mod(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._ask_odin"]


def test_description_leads_with_the_searchable_sentence(odin_mod):
    # Hermes's catalog listing shows the first sentence clipped to 60 chars: the intent leads it.
    assert odin_mod.TOOL_DESCRIPTION[:60].startswith("ODIN, the village constitution agent: ask ODIN")
    assert odin_mod.TOOL_SCHEMA["description"] == odin_mod.TOOL_DESCRIPTION
    words = set(_tokenize(odin_mod.TOOL_DESCRIPTION))
    wanted = ("odin", "constitution", "ruling", "rule", "explain", "propose", "proposed", "proposal", "question")
    assert {_tokenize(word)[0] for word in wanted} <= words


@pytest.mark.parametrize("query", ODIN_QUERIES)
def test_tool_search_finds_ask_odin_first(catalog, query):
    found = search_catalog(catalog, query)
    assert found and found[0] == "ask_odin", (query, found)


@pytest.mark.parametrize("query", [q for q in ODIN_QUERIES if q != "ask_odin"])
def test_every_query_token_is_in_ask_odin_text(catalog, query):
    assert set(_tokenize(query)) <= set(catalog["ask_odin"]), query


def test_pray_which_names_odin_stays_behind_ask_odin(catalog):
    # pray's description names "Odin" (the god agents); a query for ODIN still ranks ask_odin first.
    found = search_catalog(catalog, "odin")
    assert found[0] == "ask_odin" and "pray" in found


@pytest.mark.parametrize("query", ["group chat", "group chat messages", "village group chat history", "chat history",
                                   "what people said in the group chat", "telegram group conversation"])
def test_village_group_queries_still_find_ask_village_or_search_village_first(catalog, query):
    found = search_catalog(catalog, query)
    assert found and found[0] in ("ask_village", "search_village"), (query, found)


@pytest.mark.parametrize("query", ["who is", "people search", "tell me about a person", "rolodex"])
def test_people_queries_never_rank_ask_odin_first(catalog, query):
    found = search_catalog(catalog, query)
    assert found and found[0] == "village", (query, found)


def test_group_words_are_not_in_ask_odins_text(catalog):
    # ask_odin carries none of the words that route a group-chat or people question.
    for word in ("group", "messages", "history", "conversation", "people", "person", "who", "telegram", "said"):
        assert _tokenize(word)[0] not in catalog["ask_odin"], word
