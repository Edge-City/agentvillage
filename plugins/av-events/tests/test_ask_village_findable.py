"""ASK-VILLAGE FINDABLE (rc42): a model can find `ask_village` through Hermes's `tool_search`.

Hermes v2026.9.24 defers plugin tools: the model sees only the bridge tools and a short
catalog listing, and has to find `ask_village` with `tool_search` first. On rc41 a resident's
"group chat" question found only `session_search` (handover ASK-VILLAGE-BOX-2026-10-15 §2).

`search_catalog` below mirrors `tools/tool_search_catalog.py` (v2026.9.24, lines 38-213):
the search text is the split name + the toolset label + the description + the top-level
parameter names; a tool is admitted only if it carries the query's rarest token, and a query
of 4 or more answerable terms also needs half of them. Hermes stems tokens with Snowball;
CI installs only pytest and pyyaml, so without `snowballstemmer` the mirror matches exact
lowercase tokens. Every query here matches with exact tokens, and Snowball maps equal tokens
to equal stems, so each assertion holds under Hermes's stemming too.

The catalog is the plugin's own tools, village-bridge's `village` (whose `rolodex.search`
looks up a person) and `session_search`, the tool the model picked instead (its description
and parameter names from Hermes v2026.9.24 `tools/session_search_tool.py:651-760`, toolset
`session_search`).
"""

from __future__ import annotations

import importlib.util
import math
import re
import sys
from collections import Counter
from pathlib import Path

import pytest

try:  # Hermes's own stemmer when present; exact tokens otherwise (see the module docstring).
    import snowballstemmer

    _STEMMER = snowballstemmer.stemmer("english")

    def _stem(token: str) -> str:
        return _STEMMER.stemWord(token)
except ImportError:  # pragma: no cover - depends on the environment
    def _stem(token: str) -> str:
        return token


#: Hermes v2026.9.24 tools/session_search_tool.py SESSION_SEARCH_SCHEMA["description"].
SESSION_SEARCH_DESCRIPTION = (
    "Recall past conversations: search or read old Hermes sessions (FTS5), or "
    "scroll inside one. Four shapes, picked by args: `query` = discovery "
    "(top-N matching sessions, top result fully hydrated); `session_id` + "
    "`around_message_id` = scroll (window of messages around an anchor); "
    "`session_id` alone = read a whole session — how you resolve an "
    "`@session:<profile>/<id>` link (split on '/' into profile + id); no "
    "args = browse recent sessions. Results are actual DB messages, no LLM. "
    "Searches conversation history ONLY — when the user gave a direct "
    "source (URL, file, contact, live system), inspect that first; never "
    "conclude 'not found' from history alone. Use for questions about past "
    "conversations: 'what did we do about X', 'where did we leave Y'. When "
    "referring the user to a session, write its `link` value verbatim "
    "inline (it renders as a titled link)."
)
SESSION_SEARCH_PARAMS = ("query", "limit", "sort", "detail", "after", "before", "exclude_session_ids",
                         "session_id", "around_message_id", "window", "role_filter", "profile")

#: The words a model writes for "what is the village group saying" (the brief's list).
TARGET_WORDS = ("group", "chat", "conversation", "messages", "said", "search", "history")

#: Typical tool_search queries for the intent. Each must admit ask_village and rank it first.
INTENT_QUERIES = (
    "group chat",
    "village chat history",
    "village group chat history",
    "group chat messages",
    "search group chat messages",
    "what people said in the group chat",
    "telegram group conversation",
    "group discussion",
    "chat history",
)

#: People-lookup phrasings (lead refute OV-353 S2): `village` ranks first without the "rolodex" hint.
PEOPLE_QUERIES = (
    "who is",
    "people search",
    "search people",
    "person by name",
    "look up a person",
    "tell me about a person",
    "villager directory",
    "people directory",
    "find person",
    "rolodex",
)

VILLAGE_BRIDGE = Path(__file__).resolve().parents[2] / "village-bridge" / "__init__.py"

_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return [_stem(t.lower()) for t in _TOKEN_RE.findall(text)] if text else []


def _search_text(name: str, toolset: str, description: str, params) -> str:
    name_words = re.sub(r"[_.:-]", " ", name)
    extra = toolset if toolset and toolset not in name_words.split() else ""
    return f"{name_words} {extra} {description} {' '.join(params)}"


def _bm25(query: list[str], doc: list[str], stats, k1: float = 1.5, b: float = 0.75) -> float:
    _lengths, avg_dl, doc_freq, n_docs = stats
    score, tf_doc = 0.0, Counter(doc)
    for q in query:
        df, tf = doc_freq.get(q, 0), tf_doc.get(q, 0)
        if df and tf:
            idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
            score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(doc) / max(avg_dl, 1.0)))
    return score


def search_catalog(catalog: dict[str, list[str]], query: str, limit: int = 5) -> list[str]:
    """Hermes `search_catalog` over {name: tokens}: rarest-token gate, coverage floor, BM25 order."""
    query_tokens = _tokenize(query)
    if not query_tokens:
        return []
    lengths = [len(t) for t in catalog.values()]
    doc_freq = dict(Counter(tok for toks in catalog.values() for tok in set(toks)))
    n_docs = len(catalog)
    stats = (lengths, sum(lengths) / max(n_docs, 1), doc_freq, n_docs)

    def _idf(token: str) -> float:
        df = doc_freq.get(token, 0)
        return math.log(1 + (n_docs - df + 0.5) / (df + 0.5))

    gate = max(query_tokens, key=_idf)
    answerable = {t for t in query_tokens if doc_freq.get(t, 0) > 0}
    required = 1 if len(answerable) < 4 else math.ceil(len(answerable) * 0.5)
    exact = query.strip().lower()
    scored = []
    for name, tokens in catalog.items():
        toks = set(tokens)
        if name.lower() == exact or (gate in toks and sum(1 for t in answerable if t in toks) >= required):
            scored.append((math.inf if name.lower() == exact else _bm25(query_tokens, tokens, stats), name))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [name for _, name in scored[:limit]]


@pytest.fixture()
def catalog(plugin, av) -> dict[str, list[str]]:
    """The plugin's tools (every av-events module with a TOOL_SCHEMA) plus session_search."""
    entries: dict[str, list[str]] = {}
    for mod_name, module in sorted(sys.modules.items()):
        schema = getattr(module, "TOOL_SCHEMA", None) if mod_name.startswith(f"{av.MODULE_NAME}.") else None
        if isinstance(schema, dict) and schema.get("name"):
            toolset = getattr(module, "TOOLSET", "") or ""
            params = (schema.get("parameters") or {}).get("properties") or {}
            entries[schema["name"]] = _tokenize(_search_text(schema["name"], toolset, schema.get("description", ""),
                                                             params))
    spec = importlib.util.spec_from_file_location("askfind_village_bridge", VILLAGE_BRIDGE)
    bridge = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = bridge
    try:
        spec.loader.exec_module(bridge)
    finally:
        sys.modules.pop(spec.name, None)
        sys.modules.pop(f"{spec.name}._mini_apps", None)
    vschema = bridge.SCHEMA
    entries[vschema["name"]] = _tokenize(_search_text(vschema["name"], "village", vschema["description"],
                                                      vschema["parameters"]["properties"]))
    entries["session_search"] = _tokenize(_search_text("session_search", "session_search",
                                                       SESSION_SEARCH_DESCRIPTION, SESSION_SEARCH_PARAMS))
    assert {"ask_village", "village"} <= set(entries) and len(entries) >= 4
    return entries


@pytest.fixture()
def ask_mod(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._ask_village"]


def test_description_leads_with_the_searchable_sentence(ask_mod):
    lead = ("Village group chat: search and ask what people said or are saying in the village's main Telegram "
            "group chat (messages, conversation, discussion, history). ")
    assert ask_mod.TOOL_DESCRIPTION.startswith(lead)
    assert ask_mod.TOOL_SCHEMA["description"] == ask_mod.TOOL_DESCRIPTION
    # The original description follows, whole.
    assert "Ask one question about what has been discussed in the village's main Telegram group" in (
        ask_mod.TOOL_DESCRIPTION)
    words = set(_TOKEN_RE.findall(ask_mod.TOOL_DESCRIPTION.lower()))
    assert set(TARGET_WORDS) <= words
    # Hermes's catalog listing shows the first sentence clipped to 60 chars: the intent leads it.
    assert ask_mod.TOOL_DESCRIPTION[:60].startswith("Village group chat")


#: VILLAGE SEARCH: an explicit "search ... messages" query ranks `search_village` (the tool that returns the
#: messages themselves) first; ask_village is still admitted right behind it (test below).
SEARCH_QUERIES = ("search group chat messages", "search village messages", "search_village")


@pytest.mark.parametrize("query", [q for q in INTENT_QUERIES if q not in SEARCH_QUERIES])
def test_tool_search_finds_ask_village_first(catalog, query):
    found = search_catalog(catalog, query)
    assert found and found[0] == "ask_village", (query, found)


@pytest.mark.parametrize("query", SEARCH_QUERIES)
def test_tool_search_finds_search_village_first_for_search_queries(catalog, query):
    found = search_catalog(catalog, query)
    assert found and found[0] == "search_village", (query, found)


@pytest.mark.parametrize("query", ["search group chat messages", "group chat messages", "group chat",
                                   "village group chat"])
def test_both_village_tools_are_admitted_for_group_chat_queries(catalog, query):
    found = search_catalog(catalog, query)
    assert {"ask_village", "search_village"} <= set(found), (query, found)


#: VILLAGE QUERY: a query naming SQL ranks `query_village` first; the plain group-chat queries above still rank
#: ask_village first (its description says "posts", not "messages", in its first sentence for that reason).
QUERY_QUERIES = ("query_village", "sql", "village group chat sql", "sql group chat messages", "sqlite select")


@pytest.mark.parametrize("query", QUERY_QUERIES)
def test_tool_search_finds_query_village_first_for_sql_queries(catalog, query):
    found = search_catalog(catalog, query)
    assert found and found[0] == "query_village", (query, found)


def test_query_village_is_in_the_catalog_beside_the_other_village_tools(catalog):
    assert {"ask_village", "search_village", "query_village"} <= set(catalog)
    assert "query_village" in search_catalog(catalog, "village group chat")


@pytest.mark.parametrize("query", INTENT_QUERIES)
def test_every_query_token_is_in_ask_village_text(catalog, query):
    # Stemmer-independent: whichever token is the query's rarest in the real catalog,
    # ask_village carries it and every other term, so the gate and the coverage floor both pass.
    assert set(_tokenize(query)) <= set(catalog["ask_village"]), query


def test_group_words_keep_session_search_out(catalog):
    # "group" is in ask_village's text, not session_search's: a group query gates session_search out.
    assert "group" in catalog["ask_village"] and _stem("group") not in catalog["session_search"]
    assert "session_search" not in search_catalog(catalog, "group chat messages")


def test_exact_name_query_finds_it(catalog):
    # The AGENTS.md routing line names the tool; a tool_search for the name ranks it first.
    assert search_catalog(catalog, "ask_village")[0] == "ask_village"


def test_a_topic_word_no_tool_carries_gates_out_every_tool(catalog):
    # Hermes's gate: a query word no tool carries ("lunch") is the rarest and admits nothing;
    # Hermes then tells the model to retry without it. The intent words alone find the tool,
    # and the AGENTS.md routing line names ask_village outright for these questions.
    assert search_catalog(catalog, "group chat lunch tickets") == []
    assert search_catalog(catalog, "group chat")[0] == "ask_village"


@pytest.mark.parametrize("query", PEOPLE_QUERIES)
def test_tool_search_finds_village_first_for_people_lookups(catalog, query):
    found = search_catalog(catalog, query)
    assert found and found[0] == "village", (query, found)
    assert set(_tokenize(query)) <= set(catalog["village"]), query


def test_a_name_no_tool_carries_gates_out_every_tool(catalog):
    # A person's name is in no tool's text: "who is Asha" admits nothing, as a topic word does.
    # The AGENTS.md hint gives the model name-free queries ("rolodex", "ask_village").
    assert search_catalog(catalog, "who is Asha") == []
    assert search_catalog(catalog, "who is")[0] == "village"
