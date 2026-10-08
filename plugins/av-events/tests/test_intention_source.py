"""DATA-384, amended by DATA-410: `record_intention`'s `source` follows whose words the text is.

Rehearsal, 2026-10-07: asked "based on what you know about me, generate an
index intent", the agent wrote the text itself and passed `source=message`, so
it published as a stated intention with no approval card. DATA-384 made
`message`, `onboarding` and `note` the resident's own words only. DATA-410
(Carter's ruling the same day, corrected by the lead): the agent shows its own
words and asks once, "Should I publish this as written?", recording nothing in
that reply. A yes or the resident's own edit (`confirmed_in_chat=yes`) or a
standing go-ahead (`standing`: no ask) make the words the resident's:
`source=message`. No answer by the agent's next message of its own is captured
the same way (`silence`), and since that send is a cron or unknown session the
tool holds it for the resident's tap on the card, which the message says in
one clause (the lead's option A: the lineage gate is unchanged). A no records
nothing. `ambient` is for words the resident never saw, and for what a
background or cron run found.

`SOURCE_RULE`, `DRAFT_RULE` and `SOURCE_SHORT` in `_record_intention.py` are
the one source of truth. Each passage that states the rule is pinned whole:
the AGENTS.md Intentions bullet, the skill's "Source" and "Ask once about your
words" sections, the tools.md paragraph, the tool description and the schema's
`source` and `confirmed_in_chat` descriptions. A sentence added, dropped or
changed anywhere in one of them fails here.

The skill's examples are generated from `vectors/intention_source_exemplars.json`
(rows with a `skill` line, in order). Every row of that table is checked
against an oracle: its `kind` decides first (a yes after the capture, quoted
or forwarded words and a no to the ask record nothing; the answers to the ask
are `message` with their marker; a translation, an inferred want and a yes
that a quoted want is theirs are the agent's words, shown and asked about; a
background find is `ambient`); for the other kinds a stated source needs every
recorded word to be one of the resident's (`words(text) <= words(said)`, the
"cut, not add" test), and words that fail it are shown and asked about. The
oracle is that kind table plus a word-subset check, not a model; no model
runs here.

Outside the pinned passages, SKILL.md and tools.md must not say anything that
reads as the old where-not-whose rule (a forbidden-phrase check), the skill's
"Ambient intentions are held" section is pinned whole as well, and no prompt
keeps DATA-384's "do not ask for a yes in chat".
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
    "Whose words the text is: message, onboarding or note only for the resident's own words, and "
    "message also for your words they adopted in chat (with confirmed_in_chat); ambient for "
    "anything you composed, translated or inferred and never showed them, and for anything a "
    "background run found. Required for capture."
)

#: DATA-410: the schema's `confirmed_in_chat` description, pinned literally.
CONFIRMED_PARAM = (
    "Only with source=message, for your words the resident adopted: yes (they said yes, or edited "
    "them, after you asked once), silence (no answer by the next message you send them on your "
    "own; the tool holds it for their tap on the card), standing (they told you to go ahead "
    "without asking). Leave it out for their own words."
)
#: The one ask, word for word.
ASK = "Should I publish this as written?"

#: The one-sentence rule tool_search shows (it clips descriptions at 500 chars).
SOURCE_SHORT = (
    "source=message for the resident's own words, and for your words with confirmed_in_chat (yes, "
    "silence or standing) as the ask-once rule says; anything you composed and never showed them "
    "is ambient."
)
TOOL_SEARCH_CLIP = 500

#: Kinds that record nothing: a yes after the agent recorded its words, someone
#: else's quoted or forwarded words (not their want), and a no to the one ask.
NO_CAPTURE = {"yes-after-capture", "quoted", "declines-draft"}
#: DATA-410: the answers that make the agent's words the resident's, with the
#: marker each records (source=message).
ADOPTED = {"confirms-draft": "yes", "edits-draft": "yes", "unanswered-draft": "silence", "go-ahead": "standing"}
#: Kinds whose words the agent shows (`draft`) and asks about once, recording nothing yet.
ASK_FIRST = {"confirms-quoted", "translated", "inferred"}
#: Answers to the ask: `draft` is the words shown before `said`.
ANSWERS = {"confirms-draft", "edits-draft", "declines-draft", "unanswered-draft"}
#: Never seen by the resident: ambient, and the card asks.
ALWAYS_AMBIENT = {"background"}
#: Kinds where the resident's own words give a stated source (cut, never added to).
STATED_BY_KIND = {"own-words": "message", "asks-agent-to-write": "message", "setup": "onboarding", "note": "note"}
KINDS = NO_CAPTURE | set(ADOPTED) | ASK_FIRST | ALWAYS_AMBIENT | set(STATED_BY_KIND)
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
    assert flat(section(SKILL.read_text(encoding="utf-8"), "Ask once about your words")) == ri.DRAFT_RULE


#: The skill's "Ambient intentions are held" section, pinned whole: it sits
#: next to the rule and says what follows a capture.
AMBIENT_HELD = (
    "An ambient intention is never published on your word. It is recorded locally and stays off "
    "Index until the resident approves it in their approval channel. Where that channel is set up, "
    "the tool sends them the request itself when you capture, with the words you recorded, and "
    "publishes once they approve; you do not need to ask them in chat as well. A yes you read in "
    "chat after the capture is not an approval. Something you inferred that is personal is the exception: capture it "
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
    for heading in ("Source", "Ask once about your words", "Ambient intentions are held"):
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
        "publishes once they approved; where it is not, confirm is refused. A yes you read in chat "
        "after the capture is not an approval. action=update (intention_id, text) changes an intention you recorded here; "
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
    assert props["confirmed_in_chat"]["description"] == CONFIRMED_PARAM
    assert props["confirmed_in_chat"]["enum"] == ["yes", "silence", "standing"]
    assert props["text"]["description"] == "The intention, as the resident will read it. Required for capture and update."
    assert ri.REFUSALS["text_required"] == "Nothing was recorded: text is required."


def test_the_draft_rule_asks_once_before_recording_and_is_for_conversation_only(ri):
    # The background memory pass never messages the resident; the rule must
    # not tell it to. The ask is a reply with no tool call: text written beside
    # a tool call is dropped on the fleet's Telegram settings (no interim
    # messages), so a question asked there would never arrive.
    assert ri.DRAFT_RULE.startswith(
        f'In conversation, when the words are yours, show them in one or two lines and ask once: "{ASK}" '
        "Record nothing in that reply."
    )
    display = (REPO / "install" / "display_defaults.ts").read_text(encoding="utf-8")
    assert '{ key: "interim_assistant_messages", value: false,' in display


def test_the_draft_rule_states_each_answer_once(ri):
    """DATA-410 as corrected (option A): one ask; yes or an edit, silence
    through the next message of the agent's own (captured as message, held by
    the tool for the resident's tap, said in one clause), a standing go-ahead
    (no ask), and a no."""
    rule_text = ri.DRAFT_RULE
    assert rule_text.count(ASK) == 1
    for marker in ("yes", "silence", "standing"):
        assert rule_text.count(f"source=message and confirmed_in_chat={marker}") == 1, marker
    assert "their own edit of your words, capture the edited text the same way" in rule_text
    assert "If they say no, record nothing." in rule_text
    assert ("If they have not answered by the next message you send them on your own, capture your words as "
            "shown with source=message and confirmed_in_chat=silence; the tool holds them for the resident's tap "
            "on the approval card, and your message says so in one clause") in rule_text
    assert "\"I didn't hear back, so it's on your approval card as written; one tap publishes it.\"" in rule_text
    assert "If they have told you to go ahead without asking, do not ask" in rule_text
    assert "Never ask twice" in rule_text
    # The correction: no answer and a standing go-ahead are never ambient.
    assert "source=ambient" not in rule_text
    assert "Anything you never showed them, and anything a background or cron run found, is source=ambient." in ri.SOURCE_RULE


#: DATA-384's no-ask sentences, reversed by DATA-410, and option A's withdrawn
#: claim that silence publishes: in no prompt any more.
REVERSED = (
    "do not ask for a yes in chat", "does not make the words theirs", "does not make your words theirs",
    "publish your words as written", "published them as written", "publish as written and say so",
)


def test_the_reversed_no_ask_rule_is_gone_everywhere(ri):
    texts = {path.name: flat(path.read_text(encoding="utf-8")) for path in (AGENTS, SKILL, TOOLS)}
    texts["description"] = ri.TOOL_DESCRIPTION
    hits = [f"{label}: {phrase!r}" for label, text in texts.items() for phrase in REVERSED if phrase in text.lower()]
    assert hits == []


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
        assert list(row) == ["said", "kind", "where", "draft", "text", "source", "confirmed_in_chat", "held", "why", "skill"], row
        assert row["kind"] in KINDS, row
        assert row["where"] in ("conversation", "onboarding", "note", "background"), row
        assert row["where"] in WHERE_FOR_KIND.get(row["kind"], {"conversation", "note"}), row
        assert row["source"] in ri.SOURCES or row["source"] is None, row
        # Nothing recorded means no text; a capture always has text.
        assert (row["text"] is None) == (row["source"] is None), row
        assert row["text"] is None or row["text"].strip(), row
        assert row["said"].strip() and row["why"].strip(), row
        # A draft exists for an answer to the ask, and for an ask (nothing recorded yet).
        asks = row["text"] is None and row["kind"] not in NO_CAPTURE
        assert (row["draft"] is not None) == (row["kind"] in ANSWERS or asks), row
        assert row["draft"] is None or row["draft"].strip(), row
        # The marker goes only with message.
        assert row["confirmed_in_chat"] in (None, "yes", "silence", "standing"), row
        assert row["confirmed_in_chat"] is None or row["source"] == "message", row
        if row["skill"] is not None:
            # The example's arrow names the row's source, the ask, or says to record nothing.
            if row["source"] is not None:
                arrow = f"`{row['source']}`"
            elif asks:
                arrow = "→ show"
            else:
                arrow = "→ record nothing"
            assert arrow in row["skill"], row
            if row["confirmed_in_chat"] is not None:
                assert f"`confirmed_in_chat={row['confirmed_in_chat']}`" in row["skill"], row
            assert f'"{row["said"]}"' in row["skill"], row
    # Every source, "record nothing", every marker and every kind has an example.
    assert {row["source"] for row in EXEMPLARS} == set(ri.SOURCES) | {None}
    assert {row["kind"] for row in EXEMPLARS} == KINDS
    assert {row["confirmed_in_chat"] for row in EXEMPLARS} == {None, "yes", "silence", "standing"}
    pairs = {(row["said"], row["text"], row["source"]) for row in EXEMPLARS}
    # Someone else's words record nothing; a yes after your words are recorded records nothing new.
    assert ("Ravi says he's looking for a cofounder in Goa.", None, None) in pairs
    assert ("Yes, that's right.", None, None) in pairs
    # The rehearsal: the agent's words are shown and asked about, and recorded as
    # stated only once adopted.
    rehearsal = [r for r in EXEMPLARS if r["said"] == "Based on what you know about me, generate an index intent."]
    assert len(rehearsal) == 1 and rehearsal[0]["source"] is None and rehearsal[0]["draft"]
    assert any(r["kind"] == "confirms-draft" and r["draft"] == rehearsal[0]["draft"] and r["text"] == r["draft"]
               and r["source"] == "message" and r["confirmed_in_chat"] == "yes" for r in EXEMPLARS)
    assert any(s == "Based on what you know about me, make me an intent." and src is None for s, _, src in pairs)
    assert ("I want to meet founders building on Solana in Goa.", "Meet founders building on Solana in Goa", "message") in pairs
    # "Write me an intent: <their words>": cut-only wins (message); one added word makes it an ask.
    write_me = "Write me an intent: founders building on Solana in Goa."
    assert {src for s, _, src in pairs if s == write_me} == {"message", None}
    # DATA-410's answers: "publish as written" and an edit are message with yes;
    # silence and a standing go-ahead are message too; a no records nothing.
    by_kind: dict[str, list[dict]] = {}
    for r in EXEMPLARS:
        by_kind.setdefault(r["kind"], []).append(r)
    assert any(r["said"] == "Publish as written." for r in by_kind["confirms-draft"])
    assert {(r["source"], r["confirmed_in_chat"]) for k in ADOPTED for r in by_kind[k]} == {
        ("message", "yes"), ("message", "silence"), ("message", "standing")}
    assert all(r["source"] is None for r in by_kind["declines-draft"])
    # Option A: silence is captured as message with its marker and held for the tap.
    assert {(r["source"], r["confirmed_in_chat"], r["held"]) for r in by_kind["unanswered-draft"]} == {
        ("message", "silence", True)}
    assert all("holds it for their tap" in r["skill"] for r in by_kind["unanswered-draft"] if r["skill"])
    # Ambient only for words the resident never saw.
    assert {r["kind"] for r in EXEMPLARS if r["source"] == "ambient"} == ALWAYS_AMBIENT


def expected(row: dict) -> tuple[str | None, str | None]:
    """(source, confirmed_in_chat) the rule gives; source None records nothing now."""
    kind = row["kind"]
    if kind in NO_CAPTURE:
        return None, None
    if kind in ADOPTED:
        return "message", ADOPTED[kind]
    if kind in ALWAYS_AMBIENT:
        return "ambient", None
    if kind in ASK_FIRST:
        return None, None
    words_given = row["text"] if row["text"] is not None else row["draft"]
    if words(words_given) <= words(row["said"]):
        return STATED_BY_KIND[kind], None
    return None, None  # the agent's words: show them and ask once


@pytest.mark.parametrize("row", EXEMPLARS, ids=[f"{row['kind']}:{(row['text'] or row['draft'] or row['said'])[:30]}" for row in EXEMPLARS])
def test_every_row_follows_the_rule(row):
    source, confirmed = expected(row)
    assert row["source"] == source, row["why"]
    assert row["confirmed_in_chat"] == confirmed, row["why"]
    # The tool's answer: held for the card when ambient, and for silence, whose
    # capture comes from the agent's own cron send (the R10 gate, unchanged).
    held = None if source is None else (source == "ambient" or row["kind"] == "unanswered-draft")
    assert row["held"] is held, row["why"]
    if row["kind"] in ("confirms-draft", "unanswered-draft"):
        # Adopted, or captured on silence: the words shown, unchanged.
        assert row["text"] == row["draft"], row["why"]
    if row["kind"] == "edits-draft":
        # Their edit is the text: every word is yours as shown or theirs.
        assert row["text"] != row["draft"], row["why"]
        assert words(row["text"]) <= words(row["draft"]) | words(row["said"]), row["why"]
    if row["kind"] == "go-ahead":
        assert row["draft"] is None, row["why"]
