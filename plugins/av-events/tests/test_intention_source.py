"""DATA-384: `record_intention`'s `source` follows whose words the text is.

Rehearsal, 2026-10-07: asked "based on what you know about me, generate an
index intent", the agent wrote the text itself and passed `source=message`, so
it published as a stated intention with no approval card. The rule now says
`message`, `onboarding` and `note` are for the resident's own words only, and
that anything the agent composed, translated or inferred, or that the resident
quoted from someone else, is `ambient`, captured and then shown in the reply.

`SOURCE_RULE`, `DRAFT_RULE` and `SOURCE_SHORT` in `_record_intention.py` are
the one source of truth. Each passage that states the rule is pinned whole:
the AGENTS.md Intentions bullet, the skill's "Source" and "Show the words you
recorded" sections, the tools.md paragraph, the tool description and the
schema's `source` description. A sentence added, dropped or changed anywhere
in one of them fails here.

The skill's examples are generated from `vectors/intention_source_exemplars.json`
(rows with a `skill` line, in order). Every row of that table is checked
against an oracle: its `kind` decides first (a yes after a draft, quoted or
forwarded words, a translation, an inferred want and a background find are
always `ambient`); for the other kinds a stated source needs every recorded
word to be one of the resident's (`words(text) <= words(said)`, the "cut, not
add" test). The oracle is that kind table plus a word-subset check, not a
model; no model runs here.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
VECTOR = json.loads(
    (Path(__file__).parent / "vectors" / "intention_source_exemplars.json").read_text(encoding="utf-8")
)
EXEMPLARS: list[dict] = VECTOR["exemplars"]

AGENTS = REPO / "workspace" / "AGENTS.md"
SKILL = REPO / "skills" / "record-intention" / "SKILL.md"
TOOLS = REPO / "skills" / "index-network" / "tools.md"
MEMORY_SIGNALS = REPO / "skills" / "index-network" / "prompts" / "memory-signals.md"

#: The schema's `source` description, pinned literally: the model reads it too.
SOURCE_PARAM = (
    "Whose words the text is: message, onboarding or note only for the resident's own words; "
    "ambient for anything you composed, translated or inferred, and for words they quoted from "
    "someone else. Required for capture."
)

#: The one-sentence rule tool_search shows (it clips descriptions at 500 chars).
SOURCE_SHORT = "source=message only for the resident's own words; anything you composed is ambient."
TOOL_SEARCH_CLIP = 500

#: Kinds whose text is never the resident's own words, whatever the overlap.
ALWAYS_AMBIENT = {"yes-after-draft", "quoted", "translated", "inferred", "background"}
#: Kinds where the resident's own words give a stated source (cut, never added to).
STATED_BY_KIND = {"own-words": "message", "asks-agent-to-write": "message", "setup": "onboarding", "note": "note"}
KINDS = ALWAYS_AMBIENT | set(STATED_BY_KIND)
WHERE_FOR_KIND = {"setup": {"onboarding"}, "note": {"note"}, "background": {"background"}}


@pytest.fixture()
def ri(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._record_intention"]


def flat(text: str) -> str:
    """Backticks off and whitespace folded, so wrapped Markdown reads as one line."""
    return re.sub(r"\s+", " ", text.replace("`", "")).strip()


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.casefold()))


def section(text: str, heading: str) -> str:
    """A `## heading` section's body, up to the next `## `."""
    return text.split(f"\n## {heading}\n", 1)[1].split("\n## ", 1)[0]


def rule(ri) -> str:
    return f"{ri.SOURCE_RULE} {ri.DRAFT_RULE}"


# --------------------------------------------------------------------------
# (a) Every passage that states the rule, pinned whole
# --------------------------------------------------------------------------


def test_the_agents_md_bullet_is_exactly_the_rule_and_its_routing(ri):
    lines = [l for l in AGENTS.read_text(encoding="utf-8").splitlines() if l.startswith("- Intentions:")]
    assert len(lines) == 1
    expected = (
        "- Intentions: if record_intention is available (in your tool list, or found with tool_search "
        "and called through tool_call), record every new signal through it and never call Index "
        "create_intent or index_create_intent for a new want. "
        + rule(ri)
        + " With it available, change an intention through record_intention when it was recorded "
        "there; one it did not record may be changed with Index's own update_intent or "
        "index_update_intent, only to reword the same want. A different want is a new want and goes "
        "through record_intention. The record-intention skill has the rules. If it is not available, "
        "capture signal as the index-network skill says."
    )
    assert flat(lines[0]) == expected


def test_the_tools_md_paragraph_is_exactly_the_rule(ri):
    paragraphs = [p for p in TOOLS.read_text(encoding="utf-8").split("\n\n") if "When you call `record_intention`" in p]
    assert len(paragraphs) == 1
    assert flat(paragraphs[0]) == f"When you call record_intention: {rule(ri)}"


def test_the_skills_source_section_is_the_rule_and_the_tables_examples(ri):
    examples = [row["skill"] for row in EXEMPLARS if row["skill"]]
    expected = f"{ri.SOURCE_RULE} Examples: " + " ".join(f"- {flat(line)}" for line in examples)
    assert flat(section(SKILL.read_text(encoding="utf-8"), "Source")) == expected


def test_the_skills_draft_section_is_exactly_the_rule(ri):
    assert flat(section(SKILL.read_text(encoding="utf-8"), "Show the words you recorded")) == ri.DRAFT_RULE


def test_the_rule_is_stated_once_in_each_prompt(ri):
    for path in (AGENTS, SKILL, TOOLS):
        text = flat(path.read_text(encoding="utf-8"))
        assert text.count(ri.SOURCE_RULE) == 1, path.name
        assert text.count(ri.DRAFT_RULE) == 1, path.name


def test_the_tool_description_is_exactly_the_rule_and_the_tools_contract(ri):
    expected = (
        "Record an intention: something the person you work for wants, is looking for, or is open "
        "to, that meeting people they do not already know could serve. "
        + SOURCE_SHORT
        + " This is the one front door for intentions: never call Index create_intent or "
        "index_create_intent for a new want. This tool publishes to Index in the same call and "
        "returns the intention_id to keep for later update or withdraw calls. "
        + ri.PUBLISH_RULE
        + " Only then pass publish=false, with reason participant_asked or personal. "
        + rule(ri)
        + " Ambient intentions are never published on your word: they are held until the resident "
        "approves them in their approval channel. Where that channel is set up, the request goes to "
        "them when you capture, and action=confirm (intention_id) checks for their answer and "
        "publishes once they approved; where it is not, confirm is refused. A yes you read in chat is "
        "not an approval. action=update (intention_id, text) changes an intention you recorded here; "
        "action=withdraw (intention_id) retires it. An intention this tool did not record (made in "
        "the Index app, or before this tool was on) is not changed on Index by action=update; it may "
        "be changed with Index's own update_intent or index_update_intent, only to reword the same "
        "want. A different want is a new want and goes through this tool."
    )
    assert ri.TOOL_DESCRIPTION == expected
    assert ri.TOOL_SCHEMA["description"] == ri.TOOL_DESCRIPTION
    assert ri.SOURCE_SHORT == SOURCE_SHORT
    # tool_search shows only the first 500 characters: the short rule is inside them.
    assert SOURCE_SHORT in ri.TOOL_DESCRIPTION[:TOOL_SEARCH_CLIP]
    # Plain text: the model reads the tool description as it is.
    assert "`" not in ri.TOOL_DESCRIPTION


def test_the_schemas_source_description_is_pinned(ri):
    props = ri.TOOL_SCHEMA["parameters"]["properties"]
    assert props["source"]["description"] == SOURCE_PARAM
    assert props["text"]["description"] == "The intention, as the resident will read it. Required for capture and update."
    assert ri.REFUSALS["text_required"] == "Nothing was recorded: text is required."


def test_the_draft_rule_captures_first_and_is_for_conversation_only(ri):
    # The background memory pass never messages the resident; the rule must
    # not tell it to. Capture comes before showing: text written beside a tool
    # call is dropped on the fleet's Telegram settings (no interim messages).
    assert ri.DRAFT_RULE.startswith("In conversation, when the words are yours, capture them with source=ambient, then in your reply show")
    display = (REPO / "install" / "display_defaults.ts").read_text(encoding="utf-8")
    assert '{ key: "interim_assistant_messages", value: false,' in display


def test_the_background_memory_pass_still_records_ambient():
    prompt = MEMORY_SIGNALS.read_text(encoding="utf-8")
    assert 'source="ambient"' in prompt
    assert 'source="message"' not in prompt


# --------------------------------------------------------------------------
# (b) The table, against the rule's oracle
# --------------------------------------------------------------------------


def test_the_table_is_well_formed(ri):
    assert len(EXEMPLARS) >= 15
    for row in EXEMPLARS:
        assert list(row) == ["said", "kind", "where", "text", "source", "show_words", "why", "skill"], row
        assert row["kind"] in KINDS, row
        assert row["where"] in ("conversation", "onboarding", "note", "background"), row
        assert row["where"] in WHERE_FOR_KIND.get(row["kind"], {"conversation", "note"}), row
        assert row["source"] in ri.SOURCES, row
        assert row["text"].strip() and row["said"].strip() and row["why"].strip(), row
        if row["skill"] is not None:
            # The example's arrow names the row's source.
            assert f"→ `{row['source']}`" in row["skill"], row
            assert f'"{row["said"]}"' in row["skill"], row
    # Every source and every kind has an example.
    assert {row["source"] for row in EXEMPLARS} == set(ri.SOURCES)
    assert {row["kind"] for row in EXEMPLARS} == KINDS
    pairs = {(row["said"], row["text"], row["source"]) for row in EXEMPLARS}
    # The rehearsal and the brief's two examples.
    assert any(s == "Based on what you know about me, generate an index intent." and src == "ambient" for s, _, src in pairs)
    assert any(s == "Based on what you know about me, make me an intent." and src == "ambient" for s, _, src in pairs)
    assert ("I want to meet founders building on Solana in Goa.", "Meet founders building on Solana in Goa", "message") in pairs
    # "Write me an intent: <their words>": cut-only wins (message); one added word makes it ambient.
    write_me = "Write me an intent: founders building on Solana in Goa."
    assert {src for s, _, src in pairs if s == write_me} == {"message", "ambient"}


def expected_source(row: dict) -> str:
    if row["kind"] in ALWAYS_AMBIENT:
        return "ambient"
    if words(row["text"]) <= words(row["said"]):
        return STATED_BY_KIND[row["kind"]]
    return "ambient"


@pytest.mark.parametrize("row", EXEMPLARS, ids=[f"{row['kind']}:{row['text'][:30]}" for row in EXEMPLARS])
def test_every_row_follows_the_rule(row):
    expected = expected_source(row)
    assert row["source"] == expected, row["why"]
    # In conversation the agent's own words are shown in the reply after the
    # capture; a background pass has no chat.
    assert row["show_words"] == (expected == "ambient" and row["where"] != "background"), row["why"]
