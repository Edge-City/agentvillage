"""The app's tags entry outside a private session (lead L32765 R1): an ALLOWLIST of line shapes.

`[Context tags, kept in the Agent Village app]` passed whole into every session's USER.md block, its
Private-marked lines included. Outside a private session the gate now rebuilds it (`tags_entry_shared`)
from what may STAY, never from a list of what to drop (closed ov#560, 52ef75ea, went that way):
- Shape S: the mark, the app's header, either sections note, a card heading (or "Removed by you:"), a blank.
- Shape I (a marked entry): `- <words> (<setup|you|telegram>[, intros chat <hex>], <public|village|
  agentvillage/edgecityindia2026>)`: words with no parenthesis, line break or control character, a
  printable-ASCII tail.
- Shape U (an entry wholly in a second allowlist, no mark anywhere, no sections note; the app's gift, group
  and Summary lines allowed): its `setup`, `you` and `telegram` items with no `, guess`, and its gift lines
  under "Can offer:", as Index's B3 reads such an entry.
Never wider than Index: every kept item is one `statedItems` takes from the same entry (a property test over
the app's and the control plane's goldens and generated lines), and the read loss is counted. A private
session is byte for byte, the same object, the new code not called. Synthetic fixtures only.
"""

from __future__ import annotations

import importlib.util
import itertools
import json
import re
import sys
import types
from collections import Counter
from pathlib import Path

import pytest

SEP = "═" * 46
MARK = "[Context tags, kept in the Agent Village app]"
SETUP = "[Edge City profile, written at setup]\nSynthetic Resident, Tidepool Bay. Builds kelp sensors for the harbour."
NOTE = "Prefers calls before noon."
FIXTURES = Path(__file__).resolve().parent / "fixtures"
GOLDEN = json.loads((FIXTURES / "tags-entries.golden.json").read_text(encoding="utf-8"))


def user_block(*entries: str) -> str:
    content = "\n§\n".join(entries)
    return f"{SEP}\nUSER PROFILE (who the user is) [{len(content) * 100 // 24000}% — {len(content):,}/24,000 chars]\n{SEP}\n{content}"


def tags(*lines: str, note: bool = False, header: bool = True) -> str:
    head = [MARK] + ([GOLDEN["constants"]["entry_header"]] if header else [])
    return "\n".join(head + ([GOLDEN["constants"]["sections_note"]] if note else []) + list(lines))


@pytest.fixture()
def gate(h):
    """av-events' copy, loaded as a plain module (it is self-contained), fingerprints cleared."""
    spec = importlib.util.spec_from_file_location("av_test_user_md_tags_gate", h.AV_EVENTS_DIR / "_user_md_gate.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module._gate_reset_for_tests()
    return module


@pytest.fixture(params=["av-events", "village-memory"])
def g(request):
    """Each copy of the block in turn (byte-identical; a mutant in either must die)."""
    return request.getfixturevalue("gate" if request.param == "av-events" else "vm")


@pytest.fixture()
def index(h):
    """Index's Python reader (skills/index-network/scripts/memory_signal_gate.py): the only definition of what
    a line's mark means."""
    path = h.PLUGIN_DIR.parents[1] / "skills" / "index-network" / "scripts" / "memory_signal_gate.py"
    spec = importlib.util.spec_from_file_location("av_test_index_memory_signal_gate", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def stated(index, entry: str) -> list:
    """Index's stated items of an entry, per card (statedItems / stated_goals over every card): no guess, no
    chat, none removed, and in a marked entry only Edge City India 2026."""
    groups, removed = index.context_tags(entry)
    out = []
    for group, items in groups.items():
        for item in items:
            text, marker = item[0], item[1]
            if marker in ("guess", "chat") or index.is_removed(text, removed):
                continue
            if len(item) > 2 and item[2] != index.VISIBILITY_EDGE_CITY_INDIA_2026:
                continue
            out.append((group, text))
    return out


# ---- one grammar: the app's constants, Index's mark and headings ---------------------------------------


def test_the_structure_lines_are_the_apps_own_bytes(g, index):
    constants = GOLDEN["constants"]
    assert g.TAGS_MARK == constants["tags_mark"] == index.CONTEXT_TAGS_MARK == MARK
    assert g.TAGS_HEADER == constants["entry_header"]
    assert g.TAGS_SECTIONS_NOTES == (constants["sections_note"], constants["sections_note_old"])
    assert g.TAGS_SUMMARY_REMOVED == constants["summary_removed"]
    assert {f"{h.lower()}" for h in g.TAGS_CARD_HEADINGS} == index.ALL_HEADINGS
    assert g.TAGS_REMOVED_HEADING.lower() == index.REMOVED_HEADING


# ---- Shape I and Shape U, line by line ------------------------------------------------------------------

SHARED = [
    "- Two collaborators for a seed library (setup, public)",
    "- Tool library (you, village)",
    "- Co-op housing (telegram, public)",
    "- Intro post (telegram, intros chat 0a1b2c3d4e5f, village)",
    "- A seed library (you, agentvillage/edgecityindia2026)",
    "- x (you, public)",
    "- Words, with: commas; and [brackets] & 50% off (setup, village)",
    "- Café crawl — every Friday (you, public)",  # Index judges the tail; the words may be any text
    "- 日本語の本 (setup, village)",
]
NOT_SHARED = [
    "- Housing policy (you, private)",
    "- Housing policy (you, agentvillage/private)",
    "- A seed library (guess, village)",          # a guess is Private whatever its mark
    "- Co-op finance (chat, guess, village)",
    "- Co-op finance (chat, village)",            # the agent's reading, never the resident's words
    "- Housing policy (you, guess, public)",      # not known to be no guess
    "- Housing policy (you)",                     # no mark
    "- Housing policy",
    "- Housing policy (You, public)",             # the readers take any case; the writers print lower case
    "- Housing policy (you, Public)",
    "- Housing policy (you,public)",
    "- Housing policy  (you, public)",            # two blanks: the words would end in one
    "-  Housing policy (you, public)",
    "- Housing policy (you, public) ",            # stripped first: kept (as the readers strip it)
    "- Hidden (you, private) - Shared (you, village)",
    "- a (village) garden (you, public)",
    "- a (garden (you, public)",
    "- a ) garden (you, public)",
    "- Ctrl\x01char (you, public)",              # a control character
    "- Bom\ufeff (you, public)",                  # U+FEFF: JavaScript's \s holds it, Python's does not
    "- Del\x7fete (you, public)",
    "- Tea - Secret (you, private) (you, public)",
    "- Tab\there (you, public)",
    "- Intro (telegram, intros chat 0A1B2C3D4E5F, village)",
    "- Intro (telegram, intros chat 0a1b2c, village)",
    "- 5 hours of advice — 5 left (gift 3fa2c1)",
    "- Running a seed swap (group 3fa2c1d4e5b6)",
    "Summary: Builds seed libraries.",
    "Here to:",
    "- (you, public)",
    "- Housing policy (setup, public, village)",
    "- Housing policy (you, public)x",
]


@pytest.mark.parametrize("line", SHARED)
def test_shape_i_takes_the_shared_lines(g, index, line):
    assert g._tags_item(line, g.TAGS_SHARED_ITEM) is not None
    words, marker, mark, visibility = index.parse_item_line(line)
    assert visibility == index.VISIBILITY_EDGE_CITY_INDIA_2026 and marker in ("setup", "you", "telegram")


@pytest.mark.parametrize("line", NOT_SHARED)
def test_shape_i_takes_nothing_else(g, line):
    if line == "- Housing policy (you, public) ":
        assert g._tags_item(line, g.TAGS_SHARED_ITEM) is not None  # stripped as the readers strip it
        return
    assert g._tags_item(line, g.TAGS_SHARED_ITEM) is None


# ---- review-b ov#604 N1: the two bad-character layers back each other up, so each gets its own test -------

BAD_CHAR_LINES = ["- Tab\tin (you, public)", "- nul\x00 (you, public)", "- del\x7f (you, public)", "- nel\x85 (you, public)",
                  "- ls\u2028 (you, public)", "- ps\u2029 (you, public)", "- bom\ufeff (you, public)", "- ok (you,\tpublic)"]


@pytest.mark.parametrize("line", BAD_CHAR_LINES)
def test_the_words_regex_alone_refuses_a_bad_character(g, line):
    """Layer D: TAGS_SHARED_ITEM's words class refuses control characters, NEL, LS/PS and U+FEFF by itself."""
    assert g.TAGS_SHARED_ITEM.fullmatch(line.strip()) is None


@pytest.mark.parametrize("line", BAD_CHAR_LINES)
def test_the_bad_character_scan_alone_catches_it(g, line):
    """Layer E: _TAGS_BAD_CHARS finds the same characters anywhere on the raw line, words or tail."""
    assert g._TAGS_BAD_CHARS.search(line) is not None


#: Each BAD_CHAR_LINES line, and the same line with no mark (Shape U's form).
BAD_CHAR_ITEMS = BAD_CHAR_LINES + [line.replace(", public)", ")") for line in BAD_CHAR_LINES]


@pytest.mark.parametrize("shape_name", ["TAGS_SHARED_ITEM", "TAGS_UNMARKED_ITEM"])
def test_tags_item_refuses_a_bad_character_even_with_the_words_class_widened(g, shape_name):
    """Review-b L38718 (ov#604 N1, half), structural: `_tags_item` itself refuses every BAD_CHAR_LINES line
    when the shape's words class is widened to any character (here, in the test only), so its own
    `_TAGS_BAD_CHARS` guard is what refuses; a mutant removing that guard dies here alone, whatever the
    words class still refuses (layer D above). Not vacuous: the widened shape matches most of these lines
    whole, with clean words, so nothing else in `_tags_item` would refuse them."""
    shape = getattr(g, shape_name)
    assert g._TAGS_WORDS in shape.pattern
    widened = re.compile(shape.pattern.replace(g._TAGS_WORDS, "(?P<words>.+?)"), re.DOTALL)
    assert widened.pattern != shape.pattern
    only_the_guard = 0
    for line in BAD_CHAR_ITEMS:
        assert g._tags_item(line, widened) is None, repr(line)
        match = widened.fullmatch(line.strip())
        if match is not None and "(" not in match.group("words") and ")" not in match.group("words") \
                and match.group("words") == match.group("words").strip():
            only_the_guard += 1
    assert only_the_guard >= 4
    clean = {"TAGS_SHARED_ITEM": "- Seed library (you, public)", "TAGS_UNMARKED_ITEM": "- Seed library (you)"}[shape_name]
    assert g._tags_item(clean, widened) is not None  # the widened shape still keeps a clean line


# ---- the generated line set: every kept line is one Index reads as shared (or stated) --------------------

WORDS = ["Seed library", "x", "Words, with: commas; and [brackets]", "a (b) c", "a (you, private) b", "naïve",
         " lead", "trail ", "two  spaces", "a)b", "(", "Tab\tin", "gift — 5 left", "100% sure!", "end.", "日本語",
         "nb\u00a0sp", "zw\u200bsp", "nb\u00a0", "\x00nul", "e\u2028f", "e\x85f", "\ufeffbom", "bom\ufeff",
         "del\x7f", "c1\x9bctl", "W\u212aord"]
MARKERS = ["setup", "you", "telegram", "guess", "chat", "Setup", "YOU", "group", "gift", "ſetup", "gift 3fa2c1",
           "gift 3FA2C1", "group 0a1b2c3d4e5f", ""]
INTROS = ["", ", intros chat 0a1b2c3d4e5f", ", intros chat 0A1B2C3D4E5F", ",intros chat 0a1b2c3d4e5f"]
GUESS = ["", ", guess", ",guess"]
MARKS = ["", ", public", ", village", ", private", ", agentvillage/edgecityindia2026", ", agentvillage/private",
         ", Public", ",public", ",  village", ", publıc"]


def generated_lines() -> list:
    lines = []
    for words, marker, intro, guess, mark in itertools.product(WORDS, MARKERS, INTROS, GUESS, MARKS):
        if not marker and (intro or guess or mark):
            lines.append(f"- {words} ({(intro + guess + mark).lstrip(', ')})")
            continue
        lines.append(f"- {words} ({marker}{intro}{guess}{mark})" if marker else f"- {words}")
    return lines


GENERATED = generated_lines()


def test_every_line_shape_i_takes_reads_as_shared_and_no_guess(g, index):
    """The Python twin of the grammar pin: Shape I is NARROWER than ITEM_LINE, so it is not in that pin; every
    line it takes is one parse_item_line reads as Edge City India 2026 on a stated marker."""
    taken = [line for line in GENERATED if g._tags_item(line, g.TAGS_SHARED_ITEM) is not None]
    assert len(taken) > 50
    for line in taken:
        words, marker, mark, visibility = index.parse_item_line(line)
        assert (line, visibility, marker) == (line, index.VISIBILITY_EDGE_CITY_INDIA_2026, marker)
        assert marker in ("setup", "you", "telegram") and mark in ("public", "village", "agentvillage/edgecityindia2026")


def test_every_line_shape_u_takes_reads_as_the_same_marker_with_no_mark(g, index):
    taken = [line for line in GENERATED if g._tags_item(line, g.TAGS_UNMARKED_ITEM) is not None]
    assert len(taken) > 50
    for line in taken:
        match = g._tags_item(line, g.TAGS_UNMARKED_ITEM)
        words, marker, mark, _visibility = index.parse_item_line(line)
        assert mark is None, line
        if " intros chat " in line and match.group("guess") is not None:
            continue  # the readers take no intros ref beside a guess: the whole tail is words, still no mark
        assert words == match.group("words"), line
        if match.group("guess") is None and match.group("marker") != "chat":
            assert marker == (match.group("marker") or "telegram"), line


def _entries_from(lines: list, size: int = 7) -> list:
    """Generated entries: a marked one (a shared line first) and an unmarked one (a stated line first), each
    with the next `size` generated lines under a heading, plus a few in other places."""
    out = []
    for start in range(0, len(lines), size):
        chunk = lines[start:start + size]
        out.append(tags("Here to:", "- Shared seed library (you, public)", *chunk, "Removed by you:", chunk[0]))
        out.append(tags("Summary: A synthetic resident.", "Working on:", "- Stated seed library (setup)", *chunk))
        out.append(tags(chunk[-1], "Can offer:", *reversed(chunk), note=True))
    return out


def _never_wider(g, index, entry: str) -> list:
    """The kept entry's every item line reads as Index reads a stated line of the original entry, and Index's
    stated items of the kept entry are among the original's. Returns the original's stated lines it lost."""
    g._gate_reset_for_tests()
    unmarked = g._tags_unmarked(entry.replace("\r\n", "\n").replace("\r", "\n").split("\n"))
    out = g.tags_entry_shared(entry)
    for line in out.split("\n"):
        if not line.startswith("- "):
            assert g._tags_structure(line), line
            continue
        words, marker, mark, visibility = index.parse_item_line(line)
        if unmarked and g._tags_item(line, g.TAGS_GIFT_ITEM) is not None:
            assert mark is None and marker == "telegram" and words == line[2:], line  # Index: a stated item
        elif unmarked:
            assert mark is None and marker in ("setup", "you", "telegram"), line
            assert g._tags_item(line, g.TAGS_UNMARKED_ITEM).group("guess") is None, line
        else:
            assert visibility == index.VISIBILITY_EDGE_CITY_INDIA_2026 and marker in ("setup", "you", "telegram"), line
    before, after = stated(index, entry), stated(index, out)
    assert Counter(after) <= Counter(before), (entry, out)
    if out.strip() and stated(index, out) and not unmarked:
        assert any(len(item) > 2 for items in index.context_tags(out)[0].values() for item in items)
    return [item for item in before if item not in after]


def test_generated_entries_are_never_wider_than_index(g, index):
    entries = _entries_from(GENERATED)
    assert len(entries) > 1000
    for entry in entries:
        _never_wider(g, index, entry)


def test_the_golden_entries_are_never_wider_than_index(g, index):
    """The app's shared golden (byte-identical in the control plane) and the cp's group-section and Q9
    goldens, every tags entry in them."""
    assert len(GOLDEN["entries"]) == 93
    for entry in GOLDEN["entries"]:
        _never_wider(g, index, entry)


def _line_kind(g, line: str) -> str:
    """Why a line is outside the unmarked allowlist, or "" when it is in it (a group post anywhere counts as
    in it here: this only names a cause)."""
    if (g._tags_structure(line) or g._tags_summary(line) or g._tags_group_heading(line)
            or any(g._tags_item(line, shape) is not None
                   for shape in (g.TAGS_UNMARKED_ITEM, g.TAGS_GIFT_ITEM, g.TAGS_GROUP_ITEM))) \
            and line.strip() not in g.TAGS_SECTIONS_NOTES:
        return ""
    stripped = line.strip()
    if stripped in g.TAGS_SECTIONS_NOTES:
        return "the sections note"
    if "(gift " in stripped:
        return "a gift line"
    if "(group " in stripped or stripped.lower() == "from the village group:":
        return "the village group section"
    if stripped.startswith("- ") and g._TAGS_BAD_CHARS.search(line) is not None:
        return "an item line holding a control character"
    if stripped.startswith("- "):
        return "an item line with a mark or a parenthesis in its words"
    if stripped.startswith("Summary"):
        return "a Summary line holding a line break"
    return "another line (an older header, ...)"


def _loss_cause(g, index, entry: str, item: tuple) -> str:
    """`the line itself: <kind>` when the lost line is one no shape takes (a gift line, non-ASCII words, a bare
    `- text`), else `its entry is marked by: <kind>` (the first line outside the unmarked allowlist)."""
    lines = entry.split("\n")
    own = next(line for line in lines if line.strip().startswith("- ") and index.parse_item_line(line.strip())
               and index.parse_item_line(line.strip())[0] == item[1])
    kind = _line_kind(g, own)
    match = g._tags_item(own, g.TAGS_UNMARKED_ITEM)
    if kind:
        return f"the line itself: {kind}"
    if g._tags_unmarked(lines) and g._tags_item(own, g.TAGS_GIFT_ITEM) is not None:
        return "the line itself: a gift line under another card than Can offer"
    if g._tags_item(own, g.TAGS_GROUP_ITEM) is not None:
        return "the line itself: a group post (never kept)"
    if match is not None and match.group("marker") is None:
        return "the line itself: a bare item (no marker)"
    if match is not None and (match.group("guess") is not None or " intros chat " in own and match.group("marker") != "telegram"):
        return "the line itself: a marker list the writers never print"
    first = (next((k for k in (_line_kind(g, line) for line in lines) if k), "a group post outside its heading")
             if not g._tags_unmarked(lines) else "none")
    return f"its entry is marked by: {first}"


#: The read loss over the goldens (lead L38224 (4): the lead accepts this number or not). Index's stated items
#: in the 93 entries, the ones the allowlist keeps, and the ones it drops by cause.
READ_LOSS = {
    "stated": 1121,
    "kept": 1114,
    "lost": {
        "its entry is marked by: a group post outside its heading": 3,
        "its entry is marked by: another line (an older header, ...)": 1,
        "its entry is marked by: the sections note": 1,
        "the line itself: a bare item (no marker)": 1,
        "the line itself: a group post (never kept)": 1,
    },
}


def test_the_read_loss_over_the_goldens_is_counted(vm, index):
    lost = Counter()
    stated_total = kept_total = 0
    for entry in GOLDEN["entries"]:
        before = stated(index, entry)
        missing = _never_wider(vm, index, entry)
        stated_total += len(before)
        kept_total += len(before) - len(missing)
        for item in missing:
            lost[_loss_cause(vm, index, entry, item)] += 1
    assert {"stated": stated_total, "kept": kept_total, "lost": dict(sorted(lost.items()))} == READ_LOSS


# ---- the two modes ------------------------------------------------------------------------------------


def test_a_marked_entry_keeps_only_its_shared_items(g):
    entry = tags("Summary: A synthetic resident.", "Here to:", "- Seed library (you, public)",
                 "- Housing policy (you, private)", "- A guess (guess, village)", "- Unmarked line (setup)",
                 "Working on:", "- Co-op finance (chat, guess, village)", "Can offer:",
                 "- 5 hours of advice — 5 left (gift 3fa2c1)", "- Tools (setup, village)", "Preferences:",
                 "Removed by you:", "- Old thing (setup)", note=True)
    assert g.tags_entry_shared(entry) == tags("Here to:", "- Seed library (you, public)", "Can offer:",
                                              "- Tools (setup, village)", note=True)


def test_an_unmarked_entry_keeps_its_gift_lines_under_can_offer_and_allows_the_apps_other_lines(g, index):
    """Index's parseContextTags reads a gift line in an unmarked entry as a stated telegram item (its tail is no
    marker); the gate keeps it under "Can offer:" only. The village-group section, a Summary line with any
    words and non-ASCII words keep the entry unmarked; none of the first two is kept."""
    entry = tags("Summary: Builds (secretly) seed libraries — São Paulo.", "From the village group:",
                 "- Running a seed swap on Saturday (group 3fa2c1d4e5b6)", "Here to:", "- Café crawl — weekly (setup)",
                 "- 2 surf lessons — 2 left (gift 0bfd50)", "Can offer:", "- 5 hours of advice — 5 left (gift 3fa2c1)",
                 "- Spanish lessons (setup)", "Removed by you:", "- Old thing (setup)")
    assert g._tags_unmarked(entry.split("\n"))
    out = g.tags_entry_shared(entry)
    assert out == tags("Here to:", "- Café crawl — weekly (setup)", "Can offer:",
                       "- 5 hours of advice — 5 left (gift 3fa2c1)", "- Spanish lessons (setup)")
    assert ("can offer", "5 hours of advice — 5 left (gift 3fa2c1)") in stated(index, entry)
    marked = entry + "\n" + "- Shared (you, village)"
    assert "gift" not in g.tags_entry_shared(marked) and "Café" not in g.tags_entry_shared(marked)


def test_an_unmarked_entry_keeps_its_stated_items(g):
    """Index's B3: an entry with no mark on any line reads as before; the gate keeps its stated lines."""
    entry = tags("Summary: A synthetic resident.", "Here to:", "- Seed library (setup)", "- A guess (guess)",
                 "- Intro post (telegram, intros chat 0a1b2c3d4e5f)", "Working on:", "- Chat reading (chat)",
                 "- Chat guess (chat, guess)", "- You guess (you, guess)", "- Bare line", "- Tool library (you)",
                 "Preferences:", "Removed by you:", "- Old thing (setup)")
    assert g.tags_entry_shared(entry) == tags("Here to:", "- Seed library (setup)",
                                              "- Intro post (telegram, intros chat 0a1b2c3d4e5f)", "Working on:",
                                              "- Tool library (you)")


@pytest.mark.parametrize("extra", [
    "- Housing policy (you, private)",            # one mark anywhere: the entry is marked
    "- Shared (you, village)",
    "- a (village) garden (setup)",               # a parenthesis in the words
    "- Hidden (you, private) - x (setup)",
    "- Ctrl\x01char (setup)",                    # a control character
    "- 5 hours of advice — 5 left (gift 3FA2C1)",  # a tail that is not the gift line's exact parenthesis
    "- 5 hours of advice — 5 left (gift)",
    "- Running a seed swap (group 3fa2c1d4e5b6)",  # a group post outside its own heading
    "Summary: Builds seed libraries.\u2028- Secret (you, private)",
    "Something the gate does not know",
    "- Housing policy (you, Private)",
    "- Housing policy (you,private)",
])
def test_any_line_outside_the_second_allowlist_makes_the_entry_marked(g, extra):
    entry = tags("Here to:", "- Seed library (setup)", "- Tool (you)", extra)
    out = g.tags_entry_shared(entry)
    assert "- Seed library (setup)" not in out and "- Tool (you)" not in out
    assert out == (tags("Here to:", extra) if extra == "- Shared (you, village)" else tags())
    assert "private" not in out.split(GOLDEN["constants"]["entry_header"])[1].lower()


def test_the_sections_note_makes_an_entry_marked(g):
    """The note says an unmarked item is private; Index's B3 would read the entry unmarked (a read loss)."""
    entry = tags("Here to:", "- Seed library (setup)", note=True)
    assert g.tags_entry_shared(entry) == tags(note=True)


def test_an_entry_left_with_no_item_keeps_its_structure_lines_only(g):
    entry = tags("Here to:", "- Housing policy (you, private)", "Working on:", "Can offer:", "Preferences:",
                 "Removed by you:", "- Old thing (setup)", note=True)
    assert g.tags_entry_shared(entry) == tags(note=True)
    assert g.tags_entry_shared(tags("Here to:", "- x (you, private)")) == tags()


# ---- sections, removals, line breaks ------------------------------------------------------------------


def test_an_item_stays_only_under_a_card_heading(g):
    entry = tags("- Before any heading (you, public)", "Here to:", "- Under here (you, public)",
                 "Removed by you:", "- Under removed (you, public)", "From the village group:",
                 "- Still removed for Index (you, public)")
    assert g.tags_entry_shared(entry) == tags("Here to:", "- Under here (you, public)")


def test_an_item_never_stays_beside_its_own_removal(g):
    entry = tags("Here to:", "- Seed library (you, public)", "- Long item that the app cut (you, public)",
                 "- Other item (you, public)", "Removed by you:", "- seed library. (setup)", "- Long item that…")
    assert g.tags_entry_shared(entry) == tags("Here to:", "- Other item (you, public)")


def test_a_case_different_heading_still_opens_its_card(g, index):
    entry = tags("HERE TO:", "- Seed library (you, public)", "working on:", "- Co-op (setup, village)")
    out = g.tags_entry_shared(entry)
    assert out == entry
    assert stated(index, out) == [("here to", "Seed library"), ("working on", "Co-op")]


@pytest.mark.parametrize("lookalike", ["Here to:﻿", "\x1cRemoved by you:", "WorKing on:", "Here to:",
                                       "Working on: "])
def test_a_heading_some_reader_may_read_differently_keeps_nothing_after_it(g, lookalike):
    entry = tags("Here to:", "- Seed library (you, public)", lookalike, "- After it (you, public)",
                 "Can offer:", "- Tools (setup, village)")
    assert g.tags_entry_shared(entry) == tags("Here to:", "- Seed library (you, public)", "Can offer:",
                                              "- Tools (setup, village)")


def test_lines_are_split_as_the_readers_split_them(g):
    entry = tags("Here to:", "- Seed library (you, public)", "- Secret (you, private)").replace("\n", "\r\n")
    assert g.tags_entry_shared(entry) == tags("Here to:", "- Seed library (you, public)")
    joined = tags("Here to:", "- Seed library (you, public)\r- Secret (you, private)")
    assert g.tags_entry_shared(joined) == tags("Here to:", "- Seed library (you, public)")
    other = tags("Here to:", "- Secret (you, private) - Seed library (you, public)",
                 "- Secret two (you, private)\v- Tools (you, public)")
    assert g.tags_entry_shared(other) == tags()


# ---- the USER.md block ----------------------------------------------------------------------------------


def test_the_block_carries_the_allowlisted_entry_and_recounts_its_header(g):
    entry = tags("Here to:", "- Seed library (you, public)", "- Housing policy search (you, private)", note=True)
    shared = g.shared_user_block(user_block(SETUP, NOTE, entry))
    kept = tags("Here to:", "- Seed library (you, public)", note=True)
    assert shared == user_block(NOTE, kept)
    assert "Housing policy" not in shared and "kelp" not in shared


def test_an_entry_the_allowlist_keeps_whole_leaves_the_block_as_it_is(g):
    entry = tags("Here to:", "- Seed library (you, public)", note=True)
    block = user_block(NOTE, entry)
    assert g.shared_user_block(block) is block
    unmarked = user_block(NOTE, tags("Here to:", "- Meet people who repair things (setup)"))
    assert g.shared_user_block(unmarked) is unmarked


def test_a_tags_entry_holding_a_private_mark_is_dropped_whole(g):
    entry = tags("Here to:", "- Seed library (you, public)", SETUP)
    assert g.shared_user_block(user_block(NOTE, entry)) == user_block(NOTE)
    forged = tags("Here to:", "- [Edge City profile, written at setup] (you, public)")
    assert g.shared_user_block(user_block(NOTE, forged)) == user_block(NOTE)


def test_a_block_left_with_nothing_but_an_empty_tags_rebuild_is_dropped(g):
    assert g.shared_user_block(user_block(f"A note quoting {MARK} in passing")) == ""
    assert g.shared_user_block(user_block(SETUP, f"A note quoting {MARK} in passing")) == ""


@pytest.mark.parametrize("shape", [f"USER PROFILE [1%]\n{tags('- x (you, private)')}", tags("- x (you, private)")])
def test_an_unknown_block_shape_holding_the_tags_mark_is_dropped_whole(g, shape):
    assert g.shared_user_block(shape) == ""


# ---- the private session: byte for byte, the same object, the new code not called -----------------------


class Store:
    def __init__(self, user: str) -> None:
        self.user = user

    def format_for_system_prompt(self, target):
        return self.user if target == "user" else None


def agent_for(session, chat_type: str, block: str):
    manager = types.SimpleNamespace(providers=[session(chat_type=chat_type, platform="telegram", agent_context="primary")])
    return types.SimpleNamespace(_memory_manager=manager, _memory_store=Store(block), platform="telegram",
                                 _chat_type=chat_type)


@pytest.fixture()
def hermes_sp(monkeypatch):
    returned = {}

    def _memory_parts(agent):
        returned["parts"] = [agent._memory_store.format_for_system_prompt("user")]
        return returned["parts"]

    module = types.ModuleType("agent.system_prompt")
    module._memory_parts = _memory_parts
    module.returned = returned
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.system_prompt", module)
    return module


PRIVATE_TAGS = tags("Here to:", "- Seed library (you, public)", "- Housing policy search (you, private)", note=True)


@pytest.mark.parametrize("chat_type", ["dm", "private"])
def test_a_private_session_is_byte_for_byte_and_never_calls_the_allowlist(vm, hermes_sp, session, h, monkeypatch,
                                                                          chat_type):
    vm.register(h.FakeCtx())
    calls = []
    monkeypatch.setattr(vm, "tags_entry_shared", lambda entry: calls.append(entry) or "")
    block = user_block(SETUP, NOTE, PRIVATE_TAGS)
    agent = agent_for(session, chat_type, block)
    parts = hermes_sp._memory_parts(agent)
    assert parts is hermes_sp.returned["parts"] and parts[0] is block
    assert vm.user_block_for(agent, block) is block
    assert getattr(hermes_sp._memory_parts, vm.USER_GATE_ATTR)(agent, block) is block
    assert calls == []


@pytest.mark.parametrize(("chat_type", "platform", "agent_context"), [("group", "telegram", "primary"),
                                                                       ("", "cron", "cron"), ("thread", "slack", "primary")])
def test_a_shared_or_cron_session_gets_the_allowlisted_entry(vm, hermes_sp, session, h, chat_type, platform,
                                                             agent_context):
    vm.register(h.FakeCtx())
    manager = types.SimpleNamespace(providers=[session(chat_type=chat_type, platform=platform, agent_context=agent_context)])
    agent = types.SimpleNamespace(_memory_manager=manager, _memory_store=Store(user_block(NOTE, PRIVATE_TAGS)),
                                  platform=platform, _chat_type=chat_type)
    parts = hermes_sp._memory_parts(agent)
    assert parts == [user_block(NOTE, tags("Here to:", "- Seed library (you, public)", note=True))]


def test_a_failing_gate_leaves_the_tags_part_out(vm, hermes_sp, session, h, monkeypatch):
    vm.register(h.FakeCtx())
    monkeypatch.setattr(vm, "tags_entry_shared", lambda entry: (_ for _ in ()).throw(RuntimeError("boom")))
    assert hermes_sp._memory_parts(agent_for(session, "group", user_block(NOTE, PRIVATE_TAGS))) == []


def test_the_snapshot_gate_applies_the_allowlist_for_every_session_and_fails_closed(vm, monkeypatch):
    class MemoryStore:
        def format_for_system_prompt(self, target):
            return user_block(NOTE, PRIVATE_TAGS) if target == "user" else "MEMORY"

    gated = vm.gate_snapshot(MemoryStore.format_for_system_prompt)
    assert gated(MemoryStore(), "user") == user_block(NOTE, tags("Here to:", "- Seed library (you, public)", note=True))
    assert gated(MemoryStore(), "memory") == "MEMORY"
    monkeypatch.setattr(vm, "tags_entry_shared", lambda entry: (_ for _ in ()).throw(RuntimeError("boom")))
    assert gated(MemoryStore(), "user") is None


# ---- the latch: every dropped line is fingerprinted --------------------------------------------------------

DROPPED = "- Housing policy search (you, private)"
SHORT = "- Bob (you, private)"


@pytest.fixture()
def group_session(monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "group")
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.delenv("HERMES_PLATFORM", raising=False)


def _memory_result(**fields) -> str:
    return json.dumps(fields, ensure_ascii=False)


def test_a_dropped_line_is_fingerprinted_and_a_kept_one_is_not(g):
    g.shared_user_block(user_block(NOTE, PRIVATE_TAGS))
    assert g.holds_private_entry(f"Copied in a DM:\n{DROPPED}")
    assert not g.holds_private_entry("Copied in a DM:\n- Seed library (you, public) and more words here")
    assert not g.holds_private_entry(f"x\n{GOLDEN['constants']['entry_header']}")  # a structure line is no secret


def test_what_the_entry_keeps_never_depends_on_the_fingerprint_set(g):
    """Security review of 00a03e01: the keep decision is the entry's shape alone. A Shape I line whose digest
    is already in the latch (another session saw it in a Private entry) is still kept, and the entry with
    it, so a shared prompt never tells whether that line is Private elsewhere."""
    line = "- Seed library for the harbour co-op (you, public)"
    entry = tags("Here to:", line, note=True)
    before = g.tags_entry_shared(entry)
    g.remember_private_entries([f"[Edge City profile, written at setup]\n{line}"])
    assert g.holds_private_entry(f"x\n{line}")  # the latch holds it
    assert g.tags_entry_shared(entry) == before == entry
    block = user_block(NOTE, entry)
    assert g.shared_user_block(block) == block  # the same bytes (the header recounted to the same figure)
    g.shared_user_block(user_block(tags("Here to:", "- Housing policy search (you, private)")))
    assert g.shared_user_block(user_block(NOTE, tags("Here to:", "- Housing policy search (you, public)"))) == \
        user_block(NOTE, tags("Here to:", "- Housing policy search (you, public)"))


def test_a_memory_md_result_quoting_a_dropped_line_is_left_out_in_a_group(g, group_session):
    g.shared_user_block(user_block(NOTE, PRIVATE_TAGS))
    raw = _memory_result(success=False, error="x", current_entries=[f"A DM note:\n{DROPPED}", "Other note"])
    out = json.loads(g.transform_memory_result(tool_name="memory", result=raw, session_id="tg-group",
                                               args={"action": "add", "target": "memory", "content": "y"}))
    assert out["current_entries"] == ["Other note"]


def test_the_load_gate_fingerprints_the_dropped_lines(g):
    class MemoryStore:
        user_entries = [NOTE, PRIVATE_TAGS]

        def load_from_disk(self):
            return "loaded"

    assert g.gate_load(MemoryStore.load_from_disk)(MemoryStore()) == "loaded"
    assert g.holds_private_entry(f"A DM note:\n{DROPPED}")


def test_a_group_result_carrying_the_tags_entry_leaves_it_out_short_lines_included(g, group_session):
    """A dropped line under FINGERPRINT_MIN_CHARS has no fingerprint: the entry itself is withheld."""
    entry = tags("Here to:", "- Seed library (you, public)", SHORT, note=True)
    raw = _memory_result(success=False, error="Memory full.", current_entries=[NOTE, entry])
    out = json.loads(g.transform_memory_result(tool_name="memory", result=raw, session_id="tg-group",
                                               args={"action": "add", "target": "user", "content": "z"}))
    assert out["current_entries"] == [NOTE] and "Bob" not in json.dumps(out)
    whole = tags("Here to:", "- Seed library (you, public)", note=True)
    raw = _memory_result(success=False, error="Memory full.", current_entries=[NOTE, whole])
    assert g.transform_memory_result(tool_name="memory", result=raw, session_id="tg-group",
                                     args={"action": "add", "target": "user", "content": "z"}) is None
    assert json.loads(g.transform_memory_result(tool_name="memory", result=f"oops {entry}", session_id="tg-group")) == \
        {"success": False, "error": g.LEFT_OUT}


def test_a_dm_result_carrying_the_tags_entry_is_untouched(g, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    monkeypatch.setenv("HERMES_SESSION_CHAT_TYPE", "dm")
    raw = _memory_result(current_entries=[PRIVATE_TAGS])
    assert g.transform_memory_result(tool_name="memory", result=raw, session_id="tg-dm") is None


def test_a_group_note_quoting_a_dropped_line_reads_back_as_written(g, group_session):
    """S1-r4 (b) holds: the group's own whole text is self-written, so it reads back the same."""
    g.shared_user_block(user_block(NOTE, PRIVATE_TAGS))
    args = {"action": "add", "target": "memory", "content": f"Group note\n{DROPPED}"}
    assert g.memory_write_directive(tool_name="memory", args=args, session_id="tg-group") is None
    raw = _memory_result(success=True, current_entries=[f"Group note\n{DROPPED}"])
    out = g.transform_memory_result(tool_name="memory", result=raw, session_id="tg-group",
                                    args={"action": "add", "target": "memory", "content": "other"})
    assert out is None or json.loads(out)["current_entries"] == [f"Group note\n{DROPPED}"]
