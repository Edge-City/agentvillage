"""DIRECTORY EXPIRY FALLBACK (rc42): a failed directory never ends a people lookup.

A resident asked their agent about a person. The agent searched Index matches,
hit the attendee directory, and stopped on "the attendee directory is still
unavailable because its access has expired". The edgeos skill's §0 and §9 told
it what to say on exit 2 and exit 4 and nothing about trying another source.
The verify lane then found no grant expired fleet-wide: the agent had never
called the directory at all and repeated a stale belief from earlier in its
session (the 13-14 Oct box-token outage). So the rule is: on any person lookup,
call a source this turn; an earlier failure is stale; only a failure this turn
sends the agent to the next source (rolodex.search when installed, then
ask_village, then the website copy, then the web); and the only thing it may say
about the directory is one short line. §0, rolodex and AGENTS.md point there.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SKILL = REPO / "skills" / "edgeos" / "SKILL.md"
AGENTS = REPO / "workspace" / "AGENTS.md"
INDIA = REPO / "skills" / "edge-india" / "SKILL.md"
ROLODEX = REPO / "skills" / "rolodex" / "SKILL.md"
AGENTS_CLAUSE = "Call them this turn, not only Index; never call one unavailable from earlier."

ONE_LINE = "the directory isn't reachable right now"
SIGNIN_LINE = "To let me search the attendee directory too, sign in once at https://agents.edgecity.live/signin."


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def section(number: int) -> str:
    text = SKILL.read_text(encoding="utf-8")
    return re.search(rf"^## {number}\..*?(?=^## )", text, re.S | re.M).group(0)


def fallback() -> str:
    body = flat(section(9))
    start = body.index("**People-lookup fallback: never stop at the directory.**")
    end = body.index("**Fields:**", start)
    return body[start:end]


def test_section_9_has_the_fallback_in_order():
    text = fallback()
    chain = text[text.index("When the directory really fails this turn"):]
    order = ["1. `village` `rolodex.search`", "2. `ask_village`", "3. the public website copy in the `edge-india` skill. "
             "The chain ends there."]
    at = [chain.index(step) for step in order]
    assert at == sorted(at), dict(zip(order, at))
    assert "when that tool is installed" in text
    assert "in the same turn" in text
    assert "sources you have not tried yet" in text


def test_the_fallback_covers_every_directory_failure():
    text = fallback()
    assert "exit 1, 2 or 4" in text
    for word in ("expired", "lapsed", "unavailable", "refused", "not connected"):
        assert word in text, word


def test_the_resident_hears_at_most_one_short_line_and_never_an_expiry():
    text = fallback()
    assert f'At most add one short line: "{ONE_LINE}".' in text
    assert "Apart from the one line allowed below, never say the directory or its access expired or is unavailable" in text
    assert "never give a failure as the reason you can't find someone, and never end the answer on it" in text
    assert "No other line about the directory." in text


def test_section_0_sends_people_lookups_to_the_fallback():
    body = flat(section(0))
    assert ("**Looking someone up is different.** When the person asks who someone is, about a person, or how to "
            "reach them, run the directory script this turn (§9), even if it failed earlier in the conversation, and a "
            "directory failure (exit 1, 2 or 4) never ends the answer: skip the exit 2 and exit 4 messages above and "
            "follow §9's people-lookup fallback instead. On a real exit 4 in this turn, answer from the other sources "
            "first, then add §9's directory sign-in line once, after the answer.") in body
    # The bullet sits after both messages it overrides.
    assert body.index("When the script exits 2") < body.index("**Looking someone up is different.**")
    assert body.index("**Exit 4** (profile or directory script)") < body.index("**Looking someone up is different.**")


def test_no_resident_facing_line_is_a_dead_end():
    """Nothing the agent is told to say, in the skills or AGENTS.md, names an expiry or an unavailable directory."""
    dead_ends = re.compile(r"(access|directory|sign-in)[^\"]{0,40}\b(has expired|is expired|is still unavailable|is unavailable)", re.I)
    for path in (SKILL, INDIA, AGENTS):
        text = path.read_text(encoding="utf-8")
        # A quoted line the agent says has no Markdown code in it; that also skips mis-paired quotes.
        for quoted in re.findall(r'"([^"\n`]{12,400})"', text):
            assert not dead_ends.search(quoted), (path.name, quoted)
        assert "access has expired" not in text, path.name
    assert ONE_LINE in SKILL.read_text(encoding="utf-8")


def test_agents_md_routing_moves_on_when_a_step_fails():
    """ov#353's people route never says stop; the skill text above is the detail behind it."""
    body = flat(AGENTS.read_text(encoding="utf-8"))
    start = body.index("Who is X, tell me about a person", body.index("**People and the group.**"))
    route = body[start:body.index("The main village group", start)]
    order = ["`village` `rolodex.search`", "the `edgeos` directory", "`ask_village`", "the website copy in `edge-india`"]
    at = [route.index(step) for step in order]
    assert at == sorted(at), dict(zip(order, at))
    assert "if a step fails or finds no one, try the next" in route
    assert not re.search(r"\b(stop|give up)\b", route)


def test_every_person_lookup_calls_a_source_this_turn_and_earlier_failures_are_stale():
    text = fallback()
    assert ("always call a source this turn: the directory script (`--search` the name), or `village` "
            "`rolodex.search`, or `ask_village`. Index matches are not a people search.") in text
    assert ("Never report a source as unavailable, expired or not connected from memory or from earlier in the "
            "conversation: an earlier failure is stale, so call it again now. Only a failure in this turn counts.") in text
    # The stale rule comes before the fallback order, which applies only to a failure this turn.
    assert text.index("an earlier failure is stale") < text.index("When the directory really fails this turn")
    assert text.index("When the directory really fails this turn") < text.index("1. `village` `rolodex.search`")
    assert "run the directory script this turn (§9), even if it failed earlier in the conversation" in flat(section(0))


def test_rolodex_moves_on_to_the_directory_and_never_trusts_an_old_failure():
    body = flat(ROLODEX.read_text(encoding="utf-8"))
    assert ("For who is X, that or any other failure means you go on to the `edgeos` directory this turn "
            "(AGENTS.md order). Never call Rolodex or the directory unavailable from earlier in the conversation: "
            "an earlier failure is stale, so call again now.") in body
    assert body.index("`mini_app_not_installed`") < body.index("For who is X, that or any other failure")


def test_agents_md_carries_the_one_short_this_turn_clause():
    body = flat(AGENTS.read_text(encoding="utf-8"))
    assert len(AGENTS_CLAUSE) <= 80
    assert body.count(AGENTS_CLAUSE) == 1
    assert f"if a step fails or finds no one, try the next. {AGENTS_CLAUSE}" in body


def test_a_real_exit_4_this_turn_still_answers_then_adds_the_sign_in_line_once():
    """The residents with no Edge City grant hit exit 4 (not connected). They still get an answer from the other
    sources; §9's own directory sign-in line comes once, after it, in place of the short line, and is the only other
    line. It names the directory, not "your details", and claims no lapse (a never-granted resident had nothing to
    lapse)."""
    text = fallback()
    exception = text[text.index("The one exception is a real exit 4 in this turn"):]
    assert exception.startswith(
        "The one exception is a real exit 4 in this turn (the person's Edge City sign-in isn't connected): still answer "
        "from the other sources first, then add this directory sign-in line once, after the answer, instead of the short "
        f'line: "{SIGNIN_LINE}" No other line about the directory.')
    for word in ("your details", "lapsed", "expired", "look them up again"):
        assert word not in SIGNIN_LINE
    # The exception comes after the one-line limit it amends, and after the fallback order it relies on.
    assert text.index(ONE_LINE) < text.index("The one exception is a real exit 4")
    assert text.index("3. the public website copy") < text.index("The one exception is a real exit 4")
    # §0 points at §9's line, not at its own "your Edge City details" line, which stays for the profile.
    body0 = flat(section(0))
    assert "then add §9's directory sign-in line once, after the answer." in body0
    assert "add the exit 4 sign-in line above" not in body0
    assert "Never ask for a code, password or token." in body0


def test_no_web_step_and_no_contact_lookup_in_the_people_fallback():
    """Verify M1: the chain ends at the edge-india site (as AGENTS.md does); nothing sends a named resident to the
    open web, and nothing looks up contact details. ask_village asks what was said about them, never for contacts."""
    text = fallback()
    chain = text[text.index("When the directory really fails this turn"):text.index("Answer from what those find.")]
    assert "web" not in chain.replace("public website copy", "")
    assert "web search" not in text and "search the web" not in text and "web_search" not in text
    assert "4." not in chain
    assert ("2. `ask_village`: ask what people said about them in the main village group, never for their contact "
            "details") in chain
    assert ("For how do I reach someone, never look up contact details anywhere else: share only what the directory or "
            "Rolodex shows, and otherwise suggest their Rolodex card or a village intro instead.") in chain
    route = flat(AGENTS.read_text(encoding="utf-8"))
    assert "then the website copy in `edge-india`;" in route and "web search" not in route[route.index("**People and the group.**"):][:900]