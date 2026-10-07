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
against an oracle: its `kind` decides first (a yes after the agent's words
and quoted or forwarded words record nothing, `source` null; a yes that the
quoted want is theirs, a translation, an inferred want and a background find
are always `ambient`); for the other kinds a stated source needs every
recorded word to be one of the resident's (`words(text) <= words(said)`, the
"cut, not add" test). The oracle is that kind table plus a word-subset check,
not a model; no model runs here.

Outside the pinned passages, SKILL.md and tools.md must not say anything that
reads as the old where-not-whose rule (a forbidden-phrase check), and the
skill's "Ambient intentions are held" section is pinned whole as well.
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

#: Kinds that record nothing: a yes after the agent's words (the card already
#: asks), and someone else's quoted or forwarded words (not their want).
NO_CAPTURE = {"yes-after-draft", "quoted"}
#: Kinds whose text is never the resident's own words, whatever the overlap.
ALWAYS_AMBIENT = {"confirms-quoted", "translated", "inferred", "background"}
#: Kinds where the resident's own words give a stated source (cut, never added to).
STATED_BY_KIND = {"own-words": "message", "asks-agent-to-write": "message", "setup": "onboarding", "note": "note"}
KINDS = NO_CAPTURE | ALWAYS_AMBIENT | set(STATED_BY_KIND)
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


#: The skill's "Ambient intentions are held" section, pinned whole: it sits
#: next to the rule and says what follows a capture.
AMBIENT_HELD = (
    "An ambient intention is never published on your word. It is recorded locally and stays off "
    "Index until the resident approves it in their approval channel. Where that channel is set up, "
    "the tool sends them the request itself when you capture, with the words you recorded, and "
    "publishes once they approve; you do not need to ask them in chat as well. A yes you read in "
    "chat is not an approval. Something you inferred that is personal is the exception: capture it "
    "with publish=false and reason=personal, and it stays local and is never sent for approval. "
    "- action=confirm (with intention_id) checks whether the resident has answered and publishes it "
    "if they approved. If they have not answered yet, it says so; do not ask again and again. Where "
    "the approval channel is not set up, confirm is refused. - To change the wording of a held "
    "intention whose request is still open, withdraw it and capture the new wording; an update is "
    "refused, because the resident was asked about the words as they were. - Do not publish a held "
    "intention any other way, and do not call create_intent for it. Capturing the same text again as "
    "message, onboarding or note records it locally but does not publish it. When approvals are set "
    "up, a stated intention (message, onboarding, note) is checked against the resident's approval "
    "policy too; normally it is published in the same call. If the result says the resident has been "
    "asked, leave it: it is published when they approve."
)

#: Phrases that would key `source` on where the want was heard, or make a
#: request, a yes or a quote count as the resident's words. Checked over
#: SKILL.md and tools.md outside the pinned passages (flattened, any case).
FORBIDDEN = (
    "source=message",
    'source="message"',
    "they told you",
    "told you in conversation",
    "counts as theirs",
    "count as theirs",
    "record it again as message",
    "as message",
)


def test_the_skills_ambient_held_section_is_pinned():
    assert flat(section(SKILL.read_text(encoding="utf-8"), "Ambient intentions are held")) == AMBIENT_HELD


def _outside_pinned(ri) -> dict[str, str]:
    skill = SKILL.read_text(encoding="utf-8")
    for heading in ("Source", "Show the words you recorded", "Ambient intentions are held"):
        skill = skill.replace(f"\n## {heading}\n" + section(skill, heading), "\n")
    tools = "\n\n".join(p for p in TOOLS.read_text(encoding="utf-8").split("\n\n")
                        if "When you call `record_intention`" not in p)
    return {"SKILL.md": flat(skill), "tools.md": flat(tools)}


def test_nothing_outside_the_pinned_passages_contradicts_the_rule(ri):
    texts = _outside_pinned(ri)
    # The cut really removed the pinned passages.
    assert ri.SOURCE_RULE not in texts["SKILL.md"] and ri.DRAFT_RULE not in texts["SKILL.md"]
    assert ri.SOURCE_RULE not in texts["tools.md"]
    hits = [f"{label}: {phrase!r}" for label, text in texts.items() for phrase in FORBIDDEN
            if phrase.lower() in text.lower()]
    assert hits == []


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
        assert row["source"] in ri.SOURCES or row["source"] is None, row
        # Nothing recorded means no text; a capture always has text.
        assert (row["text"] is None) == (row["source"] is None), row
        assert row["text"] is None or row["text"].strip(), row
        assert row["said"].strip() and row["why"].strip(), row
        if row["skill"] is not None:
            # The example's arrow names the row's source, or says to record nothing.
            arrow = "→ record nothing" if row["source"] is None else f"→ `{row['source']}`"
            assert arrow in row["skill"], row
            assert f'"{row["said"]}"' in row["skill"], row
    # Every source, "record nothing" and every kind has an example.
    assert {row["source"] for row in EXEMPLARS} == set(ri.SOURCES) | {None}
    assert {row["kind"] for row in EXEMPLARS} == KINDS
    pairs = {(row["said"], row["text"], row["source"]) for row in EXEMPLARS}
    # Someone else's words record nothing; a yes after your words records nothing new.
    assert ("Ravi says he's looking for a cofounder in Goa.", None, None) in pairs
    assert ("Yes, that's right.", None, None) in pairs
    # The rehearsal and the brief's two examples.
    assert any(s == "Based on what you know about me, generate an index intent." and src == "ambient" for s, _, src in pairs)
    assert any(s == "Based on what you know about me, make me an intent." and src == "ambient" for s, _, src in pairs)
    assert ("I want to meet founders building on Solana in Goa.", "Meet founders building on Solana in Goa", "message") in pairs
    # "Write me an intent: <their words>": cut-only wins (message); one added word makes it ambient.
    write_me = "Write me an intent: founders building on Solana in Goa."
    assert {src for s, _, src in pairs if s == write_me} == {"message", "ambient"}


def expected_source(row: dict) -> str | None:
    if row["kind"] in NO_CAPTURE:
        return None
    if row["kind"] in ALWAYS_AMBIENT:
        return "ambient"
    if words(row["text"]) <= words(row["said"]):
        return STATED_BY_KIND[row["kind"]]
    return "ambient"


@pytest.mark.parametrize("row", EXEMPLARS, ids=[f"{row['kind']}:{(row['text'] or row['said'])[:30]}" for row in EXEMPLARS])
def test_every_row_follows_the_rule(row):
    expected = expected_source(row)
    assert row["source"] == expected, row["why"]
    # In conversation the agent's own words are shown in the reply after the
    # capture; a background pass has no chat; nothing recorded, nothing shown.
    assert row["show_words"] == (expected == "ambient" and row["where"] != "background"), row["why"]
