"""DATA-394: `sanitize()` cuts capability URLs to their path (a second belt).

Since overlay rc20 proactive messages carry Index's signed one-tap accept link
`https://index.network/o/<id>?action=accept&viewer=<token>&sig=<token>&surface=telegram`.
`sig` is a bearer capability. No event carries message text today; this pins
that every string an event sends (payloads, `prompt.registered` bodies) still
loses the query string of an Index URL, and that nothing else changes. The
rule is the archive's redaction rule 4 (agentvillage-data
`src/archive/redact.ts`, `archive_redaction_v3`); the cases mirror its tests
(`tests/archive-capability-urls.test.ts`). The tokens are made up.
"""

from __future__ import annotations

import json
import random
import re
from urllib.parse import quote

BS = chr(92)


VIEWER = "vW3r_t0k-EN9"
SIG = "s1G_t0k-EN42xYz"
SIGNED = f"https://index.network/o/opp_123?action=accept&viewer={VIEWER}&sig={SIG}&surface=telegram"
BARE = "https://index.network/o/opp_123"


def clean(text: str) -> None:
    assert SIG not in text, text
    assert VIEWER not in text, text
    assert not re.search(r"(?:sig|viewer)(?:=|%3d|%253d|%25253d|\\u003d)(?!\[redacted\]|$|[&#\s])", text.lower()), text


def test_a_signed_link_loses_its_whole_query_and_nothing_else_changes(plugin):
    strip = plugin.strip_capability_urls
    assert strip(SIGNED) == (BARE, 1)
    assert strip(f"Tap {SIGNED} to say yes.") == (f"Tap {BARE} to say yes.", 1)
    assert strip("https://index.network/o/opp_123?surface=telegram")[0] == BARE
    assert strip("https://index.network/u/abc#about")[0] == "https://index.network/u/abc"
    assert strip(f"https://index.network/o/opp_123?action=accept&viewer={VIEWER}#sig={SIG}")[0] == BARE
    for text in (BARE, f"{BARE}/", "index.network", "no links here", "write to bob@index.network?", "is it index.network? yes"):
        assert strip(text) == (text, 0)


def test_other_hosts_keep_their_url_and_lose_only_sig_and_viewer_values(plugin):
    for text in (
        f"https://example.com/o/x?action=accept&viewer={VIEWER}&sig={SIG}",
        f"https://notindex.network/o/x?sig={SIG}",
        f"https://my-index.network/o/x?sig={SIG}",
        f"xindex.network/o/x?sig={SIG}",
        f"https://index.network.evil.example/o/x?sig={SIG}",
        f"https://evil.example/index.network/o/x?sig={SIG}",
        f"https://index.network@evil.example/o/x?sig={SIG}",
        f"https://edgecity.live.evil.example/x?sig={SIG}",
    ):
        out, n = plugin.strip_capability_urls(text)
        clean(out)
        assert out == text.replace(SIG, "[redacted]").replace(VIEWER, "[redacted]"), text
        assert n == (2 if VIEWER in text else 1)
    for text in (
        "https://agents.edgecity.live/rolodex?person=abc",
        "https://agents.edgecity.live/intents?intent=x#top",
        "https://example.com/o/x?action=accept&surface=telegram",
        "design=1 signal=2 reviewer=3 x-sig=4 sig_x=5",
    ):
        assert plugin.strip_capability_urls(text) == (text, 0), text


def test_hosts_case_subdomains_ports_and_scheme_less(plugin):
    strip = plugin.strip_capability_urls
    assert strip(f"HTTPS://INDEX.NETWORK/o/X?SIG={SIG}")[0] == "HTTPS://INDEX.NETWORK/o/X"
    assert strip(f"https://app.Index.Network/o/x?sig={SIG}")[0] == "https://app.Index.Network/o/x"
    assert strip(f"https://index.network:443/o/x?sig={SIG}")[0] == "https://index.network:443/o/x"
    assert strip(f"open index.network/o/x?viewer={VIEWER}&sig={SIG} now")[0] == "open index.network/o/x now"
    assert strip(f"open www.index.network/o/x?sig={SIG}")[0] == "open www.index.network/o/x"


def test_markdown_html_and_punctuation_keep_their_own_characters(plugin):
    strip = plugin.strip_capability_urls
    assert strip(f"[message Ana]({SIGNED}) or [skip](https://index.network/o/opp_9)")[0] == (
        f"[message Ana]({BARE}) or [skip](https://index.network/o/opp_9)"
    )
    assert strip(f'[message Ana]({SIGNED} "Accept")')[0] == f'[message Ana]({BARE} "Accept")'
    assert strip(f"<{SIGNED}>")[0] == f"<{BARE}>"
    assert strip(f'<a href="{SIGNED}">Ana</a>')[0] == f'<a href="{BARE}">Ana</a>'
    assert strip(f"See {SIGNED}, then {SIGNED}.")[0] == f"See {BARE}, then {BARE}."
    assert strip(f"«{SIGNED}»")[0] == f"«{BARE}»"
    assert strip(f"https://index.network/o/x?a=(b)&sig={SIG} next")[0] == "https://index.network/o/x next"
    # Non-ASCII ends a URL; the sig after it is pass 2's.
    assert strip(f"https://index.network/o/x?name=José&sig={SIG} ok")[0] == "https://index.network/o/xé&sig=[redacted] ok"


def test_encoded_and_nested_links(plugin):
    strip = plugin.strip_capability_urls
    assert strip("https://index.network/o/x?viewer=a%2Bb%3D&sig=c%2Fd%3D%3D")[0] == "https://index.network/o/x"
    once = quote(SIGNED, safe="")
    assert strip(f"https://t.me/share/url?url={once}&text=hi")[0] == f"https://t.me/share/url?url={quote(BARE, safe='')}&text=hi"
    twice = quote(once, safe="")
    assert strip(f"https://x.example/r?u={twice}&k=1")[0] == f"https://x.example/r?u={quote(quote(BARE, safe=''), safe='')}&k=1"
    assert strip(f"https://t.me/share?url={SIGNED}")[0] == f"https://t.me/share?url={BARE}"


def test_json_text_stays_valid_json(plugin):
    strip = plugin.strip_capability_urls
    blob = json.dumps({"text": f"Hi\n[message Ana]({SIGNED})\nbye", "other": "https://example.com/?sig=other"})
    out, n = strip(blob)
    assert n == 2
    assert json.loads(out) == {"text": f"Hi\n[message Ana]({BARE})\nbye", "other": "https://example.com/?sig=[redacted]"}
    slashes = '{"url":"https:\\/\\/index.network\\/o\\/x?action=accept&viewer=' + VIEWER + "&sig=" + SIG + '"}'
    assert json.loads(strip(slashes)[0]) == {"url": "https://index.network/o/x"}
    unicode = '{"url":"https://index.network/o/x?action=accept\\u0026viewer=' + VIEWER + "\\u0026sig=" + SIG + '"}'
    assert json.loads(strip(unicode)[0]) == {"url": "https://index.network/o/x"}
    nested = json.dumps({"args": json.dumps({"message": f"tap {SIGNED} now"})})
    assert json.loads(json.loads(strip(nested)[0])["args"]) == {"message": f"tap {BARE} now"}


def test_portal_links_naming_sig_or_viewer_are_cut(plugin):
    strip = plugin.strip_capability_urls
    assert strip(f"https://agents.edgecity.live/o/x?action=accept&viewer={VIEWER}&sig={SIG}")[0] == "https://agents.edgecity.live/o/x"
    assert strip(f"https://agents.edgecity.live/o/x?%73ig={SIG}")[0] == "https://agents.edgecity.live/o/x"
    assert strip(f"https://agents.edgecity.live/o/x#viewer={VIEWER}")[0] == "https://agents.edgecity.live/o/x"
    assert strip("https://agents.edgecity.live/x?design=1&signal=2")[1] == 0


def test_a_link_split_across_two_strings_is_not_reassembled_but_the_sig_still_goes(plugin):
    strip = plugin.strip_capability_urls
    assert strip(f"{BARE}?action=accept&vie")[0] == BARE
    # Accepted limit: `wer=` is not a parameter name the rule knows; the sig value goes (pass 2).
    assert strip(f"wer={VIEWER}&sig={SIG}") == (f"wer={VIEWER}&sig=[redacted]", 1)


ZW = chr(0x200B)
IDEO_DOT = chr(0x3002)
FULL_DOT = chr(0xFF0E)


def test_fail_closed_upper_and_mixed_case(plugin):
    for text in (f"HTTPS://INDEX.NETWORK/O/X?ACTION=ACCEPT&VIEWER={VIEWER}&SIG={SIG}", f"https://InDeX.NeTwOrK/o/x?Sig={SIG}&ViEwEr={VIEWER}"):
        out, _ = plugin.strip_capability_urls(text)
        clean(out)
        assert "?" not in out


def test_fail_closed_encoded_and_doubly_encoded_raw_and_decoded(plugin):
    strip = plugin.strip_capability_urls
    raw = f"https://index.network/o/x?action=accept&viewer={VIEWER}&sig={SIG}"
    once = quote(raw, safe="")
    twice = quote(once, safe="")
    for text in (raw, f"see {once} now", f"see {twice} now", "q=" + once[once.index("%3F") :], "q=" + twice[twice.index("%253F") :]):
        clean(strip(text)[0])
    assert strip(f"x %26sig%3D{SIG}%26a%3D1")[0] == "x %26sig%3D[redacted]%26a%3D1"
    assert strip(f"x %2526viewer%253D{VIEWER}%2526a")[0] == "x %2526viewer%253D[redacted]%2526a"


def test_fail_closed_protocol_relative_and_scheme_less(plugin):
    strip = plugin.strip_capability_urls
    assert strip(f"//index.network/o/x?sig={SIG}")[0] == "//index.network/o/x"
    assert strip(f"index.network/o/opp_123?sig={SIG}&viewer={VIEWER}")[0] == "index.network/o/opp_123"


def test_fail_closed_markdown_trailing_paren_and_punctuation(plugin):
    for end in (")", ").", "),", ")!", ")?", ")**"):
        assert plugin.strip_capability_urls(f"[message Ana]({SIGNED}{end}")[0] == f"[message Ana]({BARE}{end}"


def test_fail_closed_newline_or_invisible_character_inside_the_host(plugin):
    for text in (
        f"https://index.\nnetwork/o/x?action=accept&viewer={VIEWER}&sig={SIG}",
        f"https://index{ZW}.network/o/x?action=accept&viewer={VIEWER}&sig={SIG}",
        f"https://in{ZW}dex.network/o/x?viewer={VIEWER}&sig={SIG}",
    ):
        out, _ = plugin.strip_capability_urls(text)
        assert SIG not in out and VIEWER not in out, out


def test_fail_closed_look_alikes_with_a_trailing_or_unicode_dot(plugin):
    strip = plugin.strip_capability_urls
    for text in (f"https://index.network./o/x?sig={SIG}", f"https://index{IDEO_DOT}network/o/x?viewer={VIEWER}&sig={SIG}", f"https://index{FULL_DOT}network/o/x?sig={SIG}"):
        clean(strip(text)[0])
    assert strip(f"https://index{IDEO_DOT}network/o/x?a=1&sig={SIG}")[0] == f"https://index{IDEO_DOT}network/o/x?a=1&sig=[redacted]"


def test_fail_closed_fragment_entities_and_json_escapes(plugin):
    strip = plugin.strip_capability_urls
    assert strip(f"https://index.network/o/x#sig={SIG}")[0] == "https://index.network/o/x"
    assert strip(f"https://example.com/x#sig={SIG}")[0] == "https://example.com/x#sig=[redacted]"
    assert strip(f"a&amp;sig={SIG}&amp;b")[0] == "a&amp;sig=[redacted]&amp;b"
    escaped = '{"u":"https://idx.example/o?x=1' + BS + 'u0026sig' + BS + 'u003d' + SIG + '"}'
    assert json.loads(strip(escaped)[0]) == {"u": "https://idx.example/o?x=1&sig=[redacted]"}


def test_fail_closed_values_end_cleanly_and_the_rule_is_idempotent(plugin):
    strip = plugin.strip_capability_urls
    assert strip(f"(sig={SIG}) [viewer={VIEWER}] 'sig={SIG}' \"sig={SIG}\". sig={SIG}, ok")[0] == (
        "(sig=[redacted]) [viewer=[redacted]] 'sig=[redacted]' \"sig=[redacted]\". sig=[redacted], ok"
    )
    once, _ = strip(f"x?sig={SIG}&viewer={VIEWER} and {SIGNED}")
    assert strip(once) == (once, 0)
    assert strip("sig= viewer=&x")[1] == 0
    assert strip(f"{SIGNED} and https://other.example/?sig={SIG}&viewer={VIEWER}")[1] == 3


MB = 1 << 20
HOSTILE = [
    "?sig=" * (MB // 5),
    "&" * MB,
    "a" * MB,
    "a." * (MB // 2) + "x",
    "a." * (MB // 2) + "index.network/o/x?sig=1",
    "index.network//" * (MB // 15),
    "x.edgecity.live/?" * (MB // 17),
    "https://index.network/o/x?" + "(" * (MB // 2) + ")" * (MB // 2),
    "https://index.network/o/x?" + ")" * MB,
    "https://index.network/o/" + BS * MB,
    "https://index.network/o/x?" + "é" * (MB // 2) + "&sig=1",
    ("https://index.network/o/x?a=" + "é") * (MB // 30),
    "%2F%2Findex.network%2F" * (MB // 22),
    "sig%3D" * (MB // 6),
    "viewer=" + "%" * MB,
    "index.network" * (MB // 13),
    (BS + "u0026sig=") * (MB // 11),
]


def test_linear_time_on_1mb_hostile_strings(plugin):
    import time

    for i, text in enumerate(HOSTILE):
        t0 = time.perf_counter()
        plugin.sanitize(text)
        assert time.perf_counter() - t0 < 1.0, i


def test_fuzz_never_leaves_a_capability_and_never_changes_the_wrapper(plugin):
    strip = plugin.strip_capability_urls
    wrappers = [("", ""), ("(", ")"), ("[x](", ")"), ("<", ">"), ('"', '"'), ("'", "'"), ("`", "`"), ("**", "**"), ("_", "_"), ("\n", "\n"), ("«", "»")]
    hosts = ["https://index.network", "http://index.network", "https://www.index.network", "https://API.INDEX.NETWORK", "index.network", "https://index.network:8443"]
    queries = [
        f"?action=accept&viewer={VIEWER}&sig={SIG}&surface=telegram",
        f"?sig={SIG}&viewer={VIEWER}",
        f"?action=accept&amp;viewer={VIEWER}&amp;sig={SIG}",
        f"?viewer={VIEWER}#sig={SIG}",
        f"#viewer={VIEWER}&sig={SIG}",
    ]
    tails = ["", ".", ",", "!", "?", ":", ";", "...", "?!"]
    rnd = random.Random(7)
    for _ in range(3000):
        open_, close = rnd.choice(wrappers)
        host = rnd.choice(hosts)
        path = rnd.choice(["/o/opp_123", "/o/opp_123/", "", "/u/x"])
        query = rnd.choice(queries)
        end = rnd.choice(tails)
        before = rnd.choice(["Hi ", "", "Ana → ", "x:"])
        text = f"{before}{open_}{host}{path}{query}{close}{end} after"
        out, n = strip(text)
        clean(out)
        assert n == 1, text
        assert out == f"{before}{open_}{host}{path}{close}{end} after", text


def test_sanitize_cuts_after_the_credential_shapes_and_labels_nothing(plugin):
    out = plugin.sanitize(f"key sk-ant-api03-{'A' * 40} and [message Ana]({SIGNED})")
    assert out == f"key [redacted:anthropic_key] and [message Ana]({BARE})"
    assert "[redacted:" not in plugin.sanitize(SIGNED)
    assert plugin.sanitize(SIGNED) == BARE


def test_sanitize_walks_a_payload_dict_and_list_and_keeps_non_strings(plugin):
    payload = {
        "text": SIGNED,
        "items": [f"a {SIGNED}", {"deep": [SIGNED, 3, None, True]}],
        "tuple": (SIGNED, 1.5),
        "n": 42,
        "ok": False,
        "none": None,
        "plain": "https://agents.edgecity.live/rolodex?person=u1",
    }
    out = plugin.sanitize(payload)
    assert out == {
        "text": BARE,
        "items": [f"a {BARE}", {"deep": [BARE, 3, None, True]}],
        "tuple": [BARE, 1.5],
        "n": 42,
        "ok": False,
        "none": None,
        "plain": "https://agents.edgecity.live/rolodex?person=u1",
    }
    clean(json.dumps(out))


def test_a_signed_link_in_a_system_prompt_never_leaves_the_box(plugin, ctx, monkeypatch, av):
    """`full` capture sends the system prompt's body (`prompt.registered`): the link goes without its query."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", "full")
    plugin.register(ctx)
    ctx.fire(
        "pre_api_request",
        session_id="sess-cap-urls",
        turn_id="t0",
        task_id="task-0",
        api_request_id="r0",
        model="anthropic/claude-sonnet-4-6",
        provider="openrouter",
        system_prompt=f"Yesterday's brief: [message Ana]({SIGNED}).",
        tool_count=0,
        approx_input_tokens=1234,
        request={"method": "POST", "body": {"model": "m", "tools": [], "messages": []}},
    )
    blob = json.dumps(av.read_buffer(plugin._COLLECTOR))
    clean(blob)
    assert f"[message Ana]({BARE})" in blob
