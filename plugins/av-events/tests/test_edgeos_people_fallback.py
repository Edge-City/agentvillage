"""DIRECTORY EXPIRY FALLBACK (rc42): a failed directory never ends a people lookup.

A resident asked their agent about a person. The agent searched Index matches,
hit the attendee directory, and stopped on "the attendee directory is still
unavailable because its access has expired". The edgeos skill's §0 and §9 told
it what to say on exit 2 and exit 4 and nothing about trying another source.
Now §9 carries a people-lookup fallback (rolodex.search when installed, then
ask_village, then the website copy, then the web), §0 points there, and the only
thing the agent may say about the directory is one short line.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SKILL = REPO / "skills" / "edgeos" / "SKILL.md"
AGENTS = REPO / "workspace" / "AGENTS.md"
INDIA = REPO / "skills" / "edge-india" / "SKILL.md"

ONE_LINE = "the directory isn't reachable right now"


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
    order = ["`village` `rolodex.search`", "`ask_village`", "`edge-india`", "a web search"]
    at = [text.index(step) for step in order]
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
    assert "Never tell the person their directory access or sign-in has expired, lapsed or is unavailable" in text
    assert "never end the answer on it" in text


def test_section_0_sends_people_lookups_to_the_fallback():
    body = flat(section(0))
    assert ("**Looking someone up is different.** When the person asks who someone is, about a person, or how to "
            "reach them, a directory failure (exit 1, 2 or 4) never ends the answer: skip the exit 2 and exit 4 "
            "messages above and follow §9's people-lookup fallback instead.") in body
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
