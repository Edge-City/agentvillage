"""ASK-VILLAGE TRIGGER: the agent knows WHEN to ask the village (product rule, 21 Oct 2026).

Before this, `ask_village` was prompted only by its own description (what it does, not when) and by the
people-lookup chains, where it is the third fallback for "Who is X"; nothing sent an open village question
("where's the best coffee", "what did people think of the dinner") to it. Product signed a rule: when to ask,
five cases not to, and 16 example prompts (`vectors/ask_village_trigger_prompts.json`).

Deterministic, no model call: the tool description carries the rule and its five do-not cases verbatim; the
edge-india routing table (§0) has a row that sends open village questions to `ask_village`, above the
"Who is X" row (which keeps Rolodex, then the directory, first) and below the calendar row (schedule and RSVPs
stay `edgeos`); every positive prompt's deciding clause is in the description and in that row, and every
negative prompt's do-not case is in both, with its alternative named. The fixture is the input for a later
live eval.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
FIXTURE = json.loads((Path(__file__).parent / "vectors" / "ask_village_trigger_prompts.json").read_text(
    encoding="utf-8"))
INDIA = REPO / "skills" / "edge-india" / "SKILL.md"

ROW_LEAD = "| What people in the village are saying, recommending, planning or asking about:"
WHO_LEAD = "| Who is X, tell me about a person |"

#: How the routing row names each do-not case (same order as the rule), with the alternative where one exists.
DO_NOT_IN_ROW = (
    "Not for the schedule, a session's time or place, or RSVPs (`edgeos`)",
    "not for logistics this guide covers (read the guide first, and ask the village only if it has no answer)",
    "not for anything private or personal about the resident",
    "not for someone's contact details (Rolodex or directory rules apply)",
    "never to post or announce something, as it only reads what was said",
)


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def table() -> list[str]:
    """The rows of edge-india §0 "Which skill answers what", header and rule line dropped."""
    text = INDIA.read_text(encoding="utf-8")
    body = re.search(r"^## 0\. Which skill answers what\n(.*?)(?=^## )", text, re.S | re.M).group(1)
    rows = [line for line in body.splitlines() if line.startswith("| ")]
    return rows[1:]  # the header row; the |---| line does not start with "| "


def row() -> str:
    found = [r for r in table() if r.startswith(ROW_LEAD)]
    assert len(found) == 1, found
    return found[0]


@pytest.fixture()
def ask_mod(plugin, av):
    return sys.modules[f"{av.MODULE_NAME}._ask_village"]


def test_the_fixture_is_products_sixteen_prompts():
    assert len(FIXTURE["positives"]) == 10 and len(FIXTURE["negatives"]) == 6
    prompts = [p["prompt"] for p in FIXTURE["positives"] + FIXTURE["negatives"]]
    assert len(set(prompts)) == 16
    assert {p["expect"] for p in FIXTURE["positives"]} == {"ask_village"}
    assert all(n["expect"] != "ask_village" and n["expect"] for n in FIXTURE["negatives"])
    assert len(FIXTURE["do_not_ask"]) == 5
    # Every do-not case decides at least one negative.
    assert {n["do_not"] for n in FIXTURE["negatives"]} == set(range(5))


def test_the_description_carries_the_rule_and_the_five_cases_verbatim(ask_mod):
    assert ask_mod.WHEN_TO_ASK == FIXTURE["rule"]
    assert list(ask_mod.DO_NOT_ASK) == FIXTURE["do_not_ask"]
    desc = ask_mod.TOOL_DESCRIPTION
    assert ask_mod.TOOL_SCHEMA["description"] == desc
    assert FIXTURE["rule"] in desc
    tail = desc[desc.index(FIXTURE["rule"]):]
    assert tail == FIXTURE["rule"] + " Do not ask the village: " + "; ".join(FIXTURE["do_not_ask"]) + "."
    # A short heading in front carries the tool_search words (test_ask_village_findable.py keeps the rankings).
    assert desc.endswith(ask_mod.WHEN_LEAD + tail)
    assert ask_mod.WHEN_LEAD == "When to ask about the village group chat (its messages and history): "
    # The rule comes after the original text, which is kept whole (searchable lead first, safety wording intact).
    assert desc.startswith("Village group chat: search and ask what people said")
    assert desc.index("Never ask for or repeat anyone's contact details.") < desc.index(FIXTURE["rule"])


@pytest.mark.parametrize("case", FIXTURE["positives"], ids=lambda c: c["prompt"])
def test_each_positive_prompts_clause_is_in_the_rule_the_description_and_the_row(ask_mod, case):
    cue = case["cue"]
    assert cue in FIXTURE["rule"], cue
    assert cue in ask_mod.TOOL_DESCRIPTION, cue
    assert cue in row(), cue


@pytest.mark.parametrize("case", FIXTURE["negatives"], ids=lambda c: c["prompt"])
def test_each_negative_prompts_case_is_in_the_description_and_the_row(ask_mod, case):
    index = case["do_not"]
    assert FIXTURE["do_not_ask"][index] in ask_mod.TOOL_DESCRIPTION
    assert DO_NOT_IN_ROW[index] in row()
    if "table_row" in case:
        # The calendar and guide rows that already send this question elsewhere are still there, above ask_village's.
        rows = table()
        hit = [i for i, r in enumerate(rows) if case["table_row"] in r]
        assert len(hit) == 1, case["table_row"]
        target = rows[hit[0]].split(" | ", 1)[1]
        assert target.startswith(case["table_route"]), target
        assert hit[0] < rows.index(row())


def test_the_row_routes_open_village_questions_before_who_is_x_and_does_not_take_it():
    rows = table()
    mine, who = rows.index(row()), next(i for i, r in enumerate(rows) if r.startswith(WHO_LEAD))
    assert who == mine + 1
    target = row().split(" | ", 1)[1]
    assert target.startswith("**`ask_village`** (the main village group), once per question; "
                             "say the answer comes from the group.")
    assert "Who is X: the next row." in target
    assert "Who is going to an event: `edgeos` first, then ask the village who plans to go." in target
    # Who is X keeps its chain: Rolodex, then the directory, then ask_village, then the website copy.
    chain = rows[who]
    at = [chain.index(s) for s in ("`village` `rolodex.search`", "the **`edgeos`** directory", "`ask_village`",
                                   "this skill's website copy")]
    assert at == sorted(at)
    # The calendar row (schedule, RSVPs) and the guide row stay above it.
    assert rows[0].startswith("| Housing, Riva") and rows[1].startswith("| What's on today or tomorrow")
    assert mine > 1


def test_the_row_names_the_rules_clauses():
    text = flat(row())
    for words in ("opinions, recommendations, plans, sightings and tips from other residents",
                  "what others think, recommend, are doing or have found",
                  "a local, practical question the calendar, this guide or the Rolodex does not answer"):
        assert words in text, words
