"""DATA-384: `record_intention`'s `source` follows whose words the text is.

Rehearsal, 2026-10-07: asked "based on what you know about me, generate an
index intent", the agent wrote the text itself and passed `source=message`, so
it published as a stated intention with no approval card. The rule now says
`message`, `onboarding` and `note` are for the resident's own words only, and
that anything the agent composed or inferred is `ambient` and shown in chat
first.

`SOURCE_RULE` and `DRAFT_RULE` in `_record_intention.py` are the one source of
truth. The tool description is built from them, and the three prompts the
agent reads (`workspace/AGENTS.md`, the record-intention skill and the
index-network tools file) must carry every sentence of both, word for word.
The skill's examples are checked against `vectors/intention_source_exemplars.json`,
and every row of that table against the rule itself. No model runs here.
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

#: The prompts that state the rule, besides the tool description.
PLACES = {
    "AGENTS.md": REPO / "workspace" / "AGENTS.md",
    "SKILL.md": REPO / "skills" / "record-intention" / "SKILL.md",
    "tools.md": REPO / "skills" / "index-network" / "tools.md",
}

#: The wording that keyed `source` on where the want was heard (DATA-384's cause).
OLD_WORDING = (
    "conversation source=message",
    "message (they told you)",
    "the resident told you in conversation",
    'text="[their words]", source="message"',
    "That holds in conversation (source=message)",
)

#: Where the resident's own words count as each stated source.
STATED = {"conversation": "message", "onboarding": "onboarding", "note": "note"}


@pytest.fixture()
def ri(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._record_intention"]


def flat(text: str) -> str:
    """Backticks off and whitespace folded, so wrapped Markdown reads as one line."""
    return re.sub(r"\s+", " ", text.replace("`", "")).strip()


def sentences(rule: str) -> list[str]:
    return [s for s in re.split(r"(?<=\.)\s+", rule) if s]


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.casefold()))


# --------------------------------------------------------------------------
# (a) One rule, stated the same in every place the agent reads
# --------------------------------------------------------------------------


def test_the_tool_description_is_built_from_the_rule(ri):
    assert ri.SOURCE_RULE in ri.TOOL_DESCRIPTION
    assert ri.DRAFT_RULE in ri.TOOL_DESCRIPTION
    assert ri.TOOL_SCHEMA["description"] == ri.TOOL_DESCRIPTION
    # Plain text: the model reads the tool description as it is.
    assert "`" not in ri.SOURCE_RULE + ri.DRAFT_RULE


@pytest.mark.parametrize("label", sorted(PLACES))
def test_each_prompt_states_every_sentence_of_the_rule_once(ri, label):
    text = flat(PLACES[label].read_text(encoding="utf-8"))
    problems = []
    for sentence in sentences(ri.SOURCE_RULE) + sentences(ri.DRAFT_RULE):
        count = text.count(sentence)
        if count != 1:
            problems.append(f"{label}: {count} copies of {sentence!r}")
    assert problems == []
    # And as one passage each, in order, not scattered.
    assert ri.SOURCE_RULE in text, label
    assert ri.DRAFT_RULE in text, label


@pytest.mark.parametrize("label", sorted(PLACES) + ["TOOL_DESCRIPTION"])
def test_no_place_keys_source_on_where_the_want_was_heard(ri, label):
    text = ri.TOOL_DESCRIPTION if label == "TOOL_DESCRIPTION" else flat(PLACES[label].read_text(encoding="utf-8"))
    assert [old for old in OLD_WORDING if old.lower() in text.lower()] == []


def test_the_schema_does_not_call_every_text_the_residents_words(ri):
    props = ri.TOOL_SCHEMA["parameters"]["properties"]
    assert "resident's words" not in props["text"]["description"]
    assert "whose words" in props["source"]["description"].lower()
    assert "resident's own words" not in ri.REFUSALS["text_required"]


def test_the_background_memory_pass_still_records_ambient():
    prompt = (REPO / "skills" / "index-network" / "prompts" / "memory-signals.md").read_text(encoding="utf-8")
    assert 'source="ambient"' in prompt
    assert 'source="message"' not in prompt


def test_the_draft_rule_is_for_conversation_only(ri):
    # The background memory pass never messages the resident; the draft rule
    # must not tell it to.
    assert ri.DRAFT_RULE.startswith("In conversation, ")


# --------------------------------------------------------------------------
# (b) The skill's examples, against the table and the table against the rule
# --------------------------------------------------------------------------


def _source_section() -> str:
    skill = PLACES["SKILL.md"].read_text(encoding="utf-8")
    return skill.split("\n## Source\n", 1)[1].split("\n## ", 1)[0]


def _skill_examples() -> list[tuple[str, str]]:
    section = _source_section()
    found = []
    # One list item at a time, its wrapped lines joined.
    for item in re.findall(r"^- (.+?)(?=^- |\Z)", section, re.MULTILINE | re.DOTALL):
        m = re.match(r'.*?"([^"]+)".*?→ (message|onboarding|note|ambient)\b', flat(item))
        if m:
            found.append((m.group(1), m.group(2)))
    return found


def test_the_table_is_well_formed(ri):
    assert len(EXEMPLARS) >= 10
    for row in EXEMPLARS:
        assert set(row) == {"said", "where", "text", "source", "draft_first", "why"}, row
        assert row["where"] in ("conversation", "onboarding", "note", "background"), row
        assert row["source"] in ri.SOURCES, row
        assert row["text"].strip() and row["said"].strip() and row["why"].strip(), row
    # Every source has an example, and the brief's two are there.
    assert {row["source"] for row in EXEMPLARS} == set(ri.SOURCES)
    by_said = {row["said"]: row["source"] for row in EXEMPLARS}
    assert by_said["Based on what you know about me, make me an intent."] == "ambient"
    assert by_said["Based on what you know about me, generate an index intent."] == "ambient"
    assert by_said["I want to meet founders building on Solana in Goa."] == "message"


@pytest.mark.parametrize("row", EXEMPLARS, ids=[row["said"][:40] for row in EXEMPLARS])
def test_every_row_follows_the_rule(row):
    """The rule as written: a stated source only for the resident's own words,
    which may be cut but not added to; anything else, and anything a background
    pass found, is ambient. In conversation, the agent's own words are shown
    first."""
    if row["where"] == "background":
        expected = "ambient"
    elif words(row["text"]) <= words(row["said"]):
        expected = STATED[row["where"]]
    else:
        expected = "ambient"
    assert row["source"] == expected, row["why"]
    assert row["draft_first"] == (expected == "ambient" and row["where"] != "background"), row["why"]


def test_the_skills_examples_are_the_tables():
    examples = _skill_examples()
    # Every list item in the section is an example the parser read.
    assert len(examples) == len(re.findall(r"^- ", _source_section(), re.MULTILINE))
    assert len(examples) >= 6
    table = {row["said"]: row["source"] for row in EXEMPLARS}
    assert [(said, source) for said, source in examples if table.get(said) != source] == []
    # Both kinds the rehearsal turned on are shown to the agent.
    assert ("Based on what you know about me, make me an intent.", "ambient") in examples
    assert ("I want to meet founders building on Solana in Goa.", "message") in examples
