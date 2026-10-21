"""The Indic joiner rule, box half (v2.1.13; approval RULING CLAIMS L18218, context L18224): U+200C ZWNJ and U+200D ZWJ
pass the technical card's `text` check (_forkicks.approval_summary) ONLY when BOTH neighbouring code points are letters
or marks (Lo, Mn, Mc) of the SAME one of ten Indic blocks. Refused everywhere else: at a value edge, doubled, next to
Latin, a digit, a space, emoji or another block, and emoji ZWJ sequences. Every other Cc, Cf, Cs, Zl and Zp code point
stays refused. card_value_fits is unchanged: core marks every joiner, so a joiner never makes a flat card.

The same rule as app#523 (forkicks-card.ts cardTextUnsafe) and cp#345 (mini-apps-approval.js cardTextUnsafe); the shared
golden vectors (tests/vectors/forkicks-approval-card.json, byte-identical in all three) pin it. Every check below goes
through approval_summary / card_fields (the shipped checks), not a helper the box does not call."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unicodedata
import unittest
from unittest.mock import patch
# pytest.ini's --import-mode=importlib keeps tests/ off sys.path, so load the shared fixture by path (once).
fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']

VECTOR_FILE = Path(__file__).with_name('vectors').joinpath('forkicks-approval-card.json')
# app#523 head 67b97414 src/lib/server/village-bridge/fixtures/forkicks-approval-card.json, copied byte for byte.
VECTOR_SHA256 = '8fb139cee3649358b4c09451f9998151e5011205c6842f10621d87a79ac66381'
VECTORS = json.loads(VECTOR_FILE.read_text(encoding='utf-8'))

ZWJ, ZWNJ = '\u200d', '\u200c'
KA, VIRAMA, SSA = '\u0915', '\u094d', '\u0937'  # Devanagari KA, sign VIRAMA, SSA
JOINER_IDS = ['d-zwj-deva', 'd-zwnj-deva', 'd-zwj-mlym', 'd-zwj-beng', 'd-zwj-latin', 'd-zwj-lead', 'd-zwj-trail',
              'd-zwj-cross', 'd-zwj-double', 'd-zwj-emoji', 'd-zwj-rlo', 'd-zwj-zwsp', 'd-zwj-deva-digit',
              'd-zwj-ascii-digit', 'd-zwj-space', 'd-zwj-block-edge', 'd-zwj-lm', 'd-zwj-mc']
POSITIVE_IDS = {'d-zwj-deva', 'd-zwnj-deva', 'd-zwj-mlym', 'd-zwj-beng', 'd-zwj-mc'}


def base():
    """The golden target card's preview: a preview that gives the flat card."""
    return copy.deepcopy(next(v for v in VECTORS['vectors'] if v['name'].startswith('target-card'))['preview'])


def unsafe(value, field='displayName'):
    """Whether approval_summary's `text` refuses `value` as the whole of one text field (default the display name)."""
    p = base()
    if field == 'displayName':
        p['displayName'] = value
    elif field == 'note':
        p['note'] = value
    try:
        fk.approval_summary({'preview': p})
    except ValueError as error:
        if str(error) != 'approval_card_invalid':
            raise
        return True
    return False


def outcome(preview):
    try:
        return {'card': fk.card_fields(preview)}
    except ValueError as error:
        return {'error': str(error)}


def H(cp):
    return 'U+%04X' % cp


class SharedVectorsTest(unittest.TestCase):
    def test_fixture_is_app_523_byte_for_byte(self):
        self.assertEqual(hashlib.sha256(VECTOR_FILE.read_bytes()).hexdigest(), VECTOR_SHA256)
        self.assertEqual(len(VECTORS['vectors']), 59)

    def test_carries_the_ruled_joiner_vectors_in_order(self):
        joiner = [v['preview']['draftId'] for v in VECTORS['vectors'] if v['preview']['draftId'].startswith(('d-zwj-', 'd-zwnj-'))]
        self.assertEqual(joiner, JOINER_IDS)

    def test_every_joiner_vector(self):
        for v in VECTORS['vectors']:
            if v['preview']['draftId'] not in JOINER_IDS:
                continue
            with self.subTest(v['preview']['draftId']):
                self.assertEqual(outcome(copy.deepcopy(v['preview'])), {'card': v['card']} if 'card' in v else {'error': v['error']})
                # Positive vectors pass the technical card but never the flat card (core marks every joiner).
                expected = 'approval_card_not_minimal' if v['preview']['draftId'] in POSITIVE_IDS else 'approval_card_invalid'
                self.assertEqual(v.get('error'), expected)
                if v['preview']['draftId'] in POSITIVE_IDS:
                    self.assertTrue(fk.approval_summary({'preview': copy.deepcopy(v['preview'])}).startswith('For Kicks order'))


class TextRuleTest(unittest.TestCase):
    # One letter + virama + letter per block (Lo, Mn, Lo); the joiner goes after the virama.
    CONJUNCTS = [('Devanagari', '\u0915\u094d\u0937'), ('Bengali', '\u0995\u09cd\u09b7'), ('Gurmukhi', '\u0a15\u0a4d\u0a38'),
                 ('Gujarati', '\u0a95\u0acd\u0ab7'), ('Oriya', '\u0b15\u0b4d\u0b37'), ('Tamil', '\u0b95\u0bcd\u0bb7'),
                 ('Telugu', '\u0c15\u0c4d\u0c37'), ('Kannada', '\u0c95\u0ccd\u0cb7'), ('Malayalam', '\u0d15\u0d4d\u0d37'),
                 ('Sinhala', '\u0d9a\u0dca\u0dc2')]

    @staticmethod
    def join(s, j):
        return s[0] + s[1] + j + s[2]

    def test_same_block_joiner_passes_in_each_of_the_ten_blocks(self):
        for block, s in self.CONJUNCTS:
            for j in (ZWJ, ZWNJ):
                with self.subTest(block=block, joiner=H(ord(j))):
                    self.assertFalse(unsafe(self.join(s, j)))
                    self.assertFalse(unsafe('x ' + self.join(s, j) + ' y'))  # inside a word of a longer value
                    self.assertTrue(unsafe(s[0] + s[1] + j + j + s[2]))  # doubled

    def test_marks_and_letters_alike_are_neighbours(self):
        self.assertFalse(unsafe(KA + ZWJ + SSA))  # Lo | Lo
        self.assertFalse(unsafe(KA + '\u093c' + ZWJ + SSA))  # nukta (Mn) | Lo
        self.assertFalse(unsafe(KA + '\u093e' + ZWJ + SSA))  # vowel sign AA (Mc) | Lo
        self.assertFalse(unsafe(KA + ZWJ + '\u093f'))  # Lo | vowel sign I (Mc)
        self.assertFalse(unsafe('\u0d28\u0d4d' + ZWJ + '\u0d7b'))  # Malayalam virama | chillu N (Lo)

    def test_refused_at_an_edge_doubled_or_next_to_latin_digit_space_punctuation_or_emoji(self):
        for j in (ZWJ, ZWNJ):
            for bad in (j + KA + VIRAMA + SSA, KA + VIRAMA + j, j, j + j, KA + VIRAMA + j + j + SSA, KA + j + ZWNJ + SSA,
                        KA + ZWNJ + j + SSA, 'ab' + j + 'cd', KA + VIRAMA + j + 'a', 'a' + j + KA, KA + VIRAMA + j + '1',
                        '1' + j + KA, KA + VIRAMA + j + ' ' + SSA, KA + ' ' + j + SSA, KA + VIRAMA + j + '-',
                        '\U0001f469' + j + '\U0001f4bb', KA + VIRAMA + j + '\U0001f469', '\U0001f469' + j + KA,
                        '\U0001f468' + ZWJ + '\U0001f469' + ZWJ + '\U0001f467'):
                with self.subTest(bad=bad.encode('unicode_escape').decode()):
                    self.assertTrue(unsafe(bad))

    def test_a_joiner_at_either_edge_never_wraps_to_the_other_end(self):
        # A value edge is no neighbour: the last code point is not the first one's left neighbour (no index wrap).
        for j in (ZWJ, ZWNJ):
            self.assertTrue(unsafe(j + KA + SSA + KA))
            self.assertTrue(unsafe(KA + SSA + KA + j))
            self.assertTrue(unsafe(j + KA))
            self.assertTrue(unsafe(KA + j))
            self.assertTrue(unsafe(KA + j, field='note'))
            self.assertTrue(unsafe(j + KA, field='note'))

    def test_refused_between_two_different_blocks(self):
        for i, (a_name, a) in enumerate(self.CONJUNCTS):
            for k, (c_name, c) in enumerate(self.CONJUNCTS):
                if i != k:
                    with self.subTest(left=a_name, right=c_name):
                        self.assertTrue(unsafe(a[0] + a[1] + ZWJ + c[2]))
        self.assertTrue(unsafe('\u097f' + ZWJ + '\u0985'))  # last Devanagari letter | Bengali vowel letter A

    def test_a_neighbour_must_be_lo_mn_or_mc(self):
        self.assertTrue(unsafe(KA + ZWJ + '\u0966'))  # Devanagari digit zero (Nd)
        self.assertTrue(unsafe('\u0966' + ZWJ + KA))
        self.assertTrue(unsafe(KA + ZWJ + '\u0964'))  # danda (Po)
        self.assertTrue(unsafe('\u09fa' + ZWJ + '\u0995'))  # Bengali isshar (So)
        self.assertTrue(unsafe('\u0995' + ZWJ + '\u0984'))  # unassigned in the Bengali block (Cn)
        self.assertTrue(unsafe(KA + ZWJ + '\u0971'))  # high spacing dot (Lm)
        self.assertFalse(unsafe(KA + '\u0903' + ZWJ + '\u0903'))  # visarga (Mc) | visarga (Mc): same block

    def test_other_brahmic_scripts_outside_the_ten_blocks_are_refused(self):
        self.assertTrue(unsafe('\u0f40\u0f84' + ZWJ + '\u0f66'))  # Tibetan
        self.assertTrue(unsafe('\u1000\u1039' + ZWJ + '\u1000'))  # Myanmar
        self.assertTrue(unsafe('\u1780\u17d2' + ZWJ + '\u1780'))  # Khmer

    def test_every_other_cc_cf_cs_zl_zp_code_point_stays_refused_even_inside_a_conjunct(self):
        refused = [cp for cp in range(0x110000) if unicodedata.category(chr(cp)) in {'Cc', 'Cf', 'Zl', 'Zp'}
                   and cp not in (0x200C, 0x200D)]
        refused += [0xD800, 0xDBFF, 0xDC00, 0xDFFF]  # lone surrogates (Cs) a Python str can hold
        self.assertGreater(len(refused), 200)
        for cp in refused:
            with self.subTest(H(cp)):
                self.assertTrue(unsafe(KA + VIRAMA + chr(cp) + SSA))
                self.assertTrue(unsafe(KA + VIRAMA + chr(cp) + SSA, field='note'))
        for ok in ('Alex', 'Zo\u00eb', KA + VIRAMA + SSA, 'Oat milk', '\u2615'):
            self.assertFalse(unsafe(ok), ok)

    def test_card_value_fits_is_unchanged_a_joiner_never_fits(self):
        for j in (ZWJ, ZWNJ):
            self.assertFalse(fk.card_value_fits(KA + VIRAMA + j + SSA))
            self.assertFalse(fk.card_value_fits(KA + VIRAMA + j + SSA, lines=True))
        self.assertTrue(fk.card_value_fits(KA + VIRAMA + SSA))


class BlockEdgeTest(unittest.TestCase):
    """approval RULING L18451, review-b N1: for all ten blocks, the first and last code point that is a letter or mark
    (Lo, Mn, Mc) on this runtime pass as same-block neighbours with both joiners in both orders; the block's lo-1,
    lo-2, hi+1 and hi+2 are refused next to them. Kannada's last is U+0CF3 (Mc, Unicode 15.0); on an older
    unicodedata (Python 3.11: 14.0) U+0CF3 is unassigned and U+0CF2 is the last."""
    KANNADA_LAST = 0x0CF3 if tuple(int(n) for n in unicodedata.unidata_version.split('.')) >= (15, 0) else 0x0CF2
    BLOCKS = [('Devanagari', 0x0900, 0x097F, 0x0900, 0x097F), ('Bengali', 0x0980, 0x09FF, 0x0980, 0x09FE),
              ('Gurmukhi', 0x0A00, 0x0A7F, 0x0A01, 0x0A75), ('Gujarati', 0x0A80, 0x0AFF, 0x0A81, 0x0AFF),
              ('Oriya', 0x0B00, 0x0B7F, 0x0B01, 0x0B71), ('Tamil', 0x0B80, 0x0BFF, 0x0B82, 0x0BD7),
              ('Telugu', 0x0C00, 0x0C7F, 0x0C00, 0x0C63), ('Kannada', 0x0C80, 0x0CFF, 0x0C80, KANNADA_LAST),
              ('Malayalam', 0x0D00, 0x0D7F, 0x0D00, 0x0D7F), ('Sinhala', 0x0D80, 0x0DFF, 0x0D81, 0x0DF3)]

    @staticmethod
    def neighbour(cp):
        return unicodedata.category(chr(cp)) in ('Lo', 'Mn', 'Mc')

    def block_of(self, cp):
        return next((i for i, (_, lo, hi, _, _) in enumerate(self.BLOCKS) if lo <= cp <= hi), -1)

    def test_the_table_is_the_ruled_one(self):
        self.assertEqual([(lo, hi) for _, lo, hi, _, _ in self.BLOCKS], list(fk.INDIC_BLOCKS))

    def test_first_and_last_letter_or_mark_pass_both_ways_with_both_joiners(self):
        for name, lo, hi, first, last in self.BLOCKS:
            self.assertEqual([first >= lo, last <= hi, self.neighbour(first), self.neighbour(last)], [True] * 4, name)
            for cp in range(lo, first):
                self.assertFalse(self.neighbour(cp), '%s %s before its first' % (name, H(cp)))
            for cp in range(last + 1, hi + 1):
                self.assertFalse(self.neighbour(cp), '%s %s after its last' % (name, H(cp)))
            for j in (ZWJ, ZWNJ):
                with self.subTest(block=name, joiner=H(ord(j))):
                    self.assertFalse(unsafe(chr(first) + j + chr(last)))
                    self.assertFalse(unsafe(chr(last) + j + chr(first)))
                    self.assertFalse(unsafe(chr(first) + j + chr(first)))
                    self.assertFalse(unsafe(chr(last) + j + chr(last)))

    def test_lo_minus_1_and_2_and_hi_plus_1_and_2_are_refused(self):
        for name, lo, hi, first, last in self.BLOCKS:
            for j in (ZWJ, ZWNJ):
                for out in (lo - 1, lo - 2):
                    with self.subTest(block=name, out=H(out), joiner=H(ord(j))):
                        self.assertTrue(unsafe(chr(out) + j + chr(first)))
                        self.assertTrue(unsafe(chr(first) + j + chr(out)))
                        self.assertTrue(unsafe(chr(out) + j + chr(last)))
                for out in (hi + 1, hi + 2):
                    with self.subTest(block=name, out=H(out), joiner=H(ord(j))):
                        self.assertTrue(unsafe(chr(last) + j + chr(out)))
                        self.assertTrue(unsafe(chr(out) + j + chr(last)))
                        self.assertTrue(unsafe(chr(first) + j + chr(out)))
        self.assertTrue(unsafe('\u08ff' + ZWJ + '\u0900'))  # Arabic Mn | first Devanagari (Mn)
        self.assertTrue(unsafe('\u097f' + ZWJ + '\u0980'))  # last Devanagari (Lo) | first Bengali (Lo)
        self.assertTrue(unsafe('\u0aff' + ZWJ + '\u0b01'))  # last Gujarati (Mn) | first Oriya (Mn)
        self.assertTrue(unsafe('\u0bd7' + ZWJ + '\u0c00'))  # last Tamil (Mc) | first Telugu (Mn)
        self.assertTrue(unsafe('\u0c63' + ZWJ + '\u0c80'))  # Telugu (Mn) | first Kannada (Lo)
        self.assertTrue(unsafe('\u0c95' + ZWJ + '\u0d00'))  # Kannada KA (Lo) | first Malayalam (Mn)
        self.assertTrue(unsafe('\u0d7f' + ZWJ + '\u0d81'))  # last Malayalam (Lo) | first Sinhala (Mn)
        self.assertTrue(unsafe('\u0df3' + ZWJ + '\u0e01'))  # last Sinhala (Mc) | Thai KO KAI (Lo)

    def test_matches_the_table_for_every_code_point_u08f0_to_u0e0f(self):
        checked = 0
        for a in range(0x08F0, 0x0E10):
            for b in (a, a + 1, a + 2):
                same = self.block_of(a) >= 0 and self.block_of(a) == self.block_of(b) and self.neighbour(a) and self.neighbour(b)
                for j in (ZWJ, ZWNJ):
                    self.assertEqual(unsafe(chr(a) + j + chr(b)), not same, '%s|%s' % (H(a), H(b)))
                    self.assertEqual(unsafe(chr(b) + j + chr(a)), not same, '%s|%s' % (H(b), H(a)))
                    checked += 2
        self.assertEqual(checked, (0x0E0F - 0x08F0 + 1) * 3 * 4)


class EveryTextFieldTest(unittest.TestCase):
    GOOD, BAD = KA + VIRAMA + ZWJ + SSA, 'Ab' + ZWJ + 'cd'

    def cases(self):
        def item(p, s): p['quote']['lines'][0]['name'] = s
        def option(p, s): p['quote']['lines'][0]['options'][0] = s
        def place(p, s): p['quote']['location']['name'] = s
        def address(p, s): p['quote']['location']['address'] = s
        def location_id(p, s): p['fulfilment']['locationId'] = s
        def name(p, s): p['displayName'] = s
        return [('item name', item), ('option', option), ('place', place), ('address', address),
                ('locationId', location_id), ('display name', name)]

    def test_a_same_block_joiner_passes_the_technical_card_a_latin_one_is_invalid(self):
        flat = fk.card_fields(base())
        for field, set_ in self.cases():
            with self.subTest(field):
                good, bad = base(), base()
                set_(good, self.GOOD); set_(bad, self.BAD)
                self.assertTrue(fk.approval_summary({'preview': copy.deepcopy(good)}).startswith('For Kicks order'))
                if field in ('address', 'locationId'):  # not one of the four rows: the flat card is unchanged
                    self.assertEqual(outcome(good), {'card': flat})
                else:
                    self.assertEqual(outcome(good), {'error': 'approval_card_not_minimal'})
                self.assertEqual(outcome(bad), {'error': 'approval_card_invalid'})

    def test_the_note_follows_the_rule_and_keeps_allow_empty(self):
        flat = fk.card_fields(base())
        for note, expected in ((self.GOOD, {'card': flat}), (self.BAD, {'error': 'approval_card_invalid'}), ('', {'card': flat})):
            p = base(); p['note'] = note
            self.assertEqual(outcome(p), expected, repr(note))

    def test_a_delivery_address_follows_the_rule(self):
        for value, refused in ((self.GOOD, False), (self.BAD, True)):
            p = base(); p['fulfilment'] = {'type': 'delivery', 'locationId': 'mandrem', 'date': '2026-10-21', 'deliveryAddress': value}
            try:
                fk.approval_summary({'preview': p}); got = False
            except ValueError as error:
                self.assertEqual(str(error), 'approval_card_invalid'); got = True
            self.assertEqual(got, refused, repr(value))


class PrepareNoteTest(unittest.TestCase):
    """__init__.py's prepare-time note check refuses what the approval card would refuse (so the agent learns at
    prepare, not at confirm): it follows the same joiner rule, so a same-block joiner in the note is not refused there."""
    setUp = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def enable(self):
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        gate = patch.object(bridge, 'gate_verified', return_value=None); self.gate = gate.start(); self.addCleanup(gate.stop)

    def order(self, note):
        return {'operation': 'forkicks.order.prepare', 'fulfilment': {'locationId': 'cafe', 'type': 'pickup', 'date': '2026-10-19'},
                'items': [{'itemId': 'coffee', 'qty': 1, 'optionIds': ['oat']}], 'paymentMethod': 'upi', 'note': note}

    def result_for(self, order, draft):
        # One draftId per prepare: the box keeps the first preview per draftId (O_EXCL) and refuses a different one.
        quote = {'quoteId': 'quote-1', 'canOrder': True, 'totalInr': 190, 'location': {'name': 'Cafe', 'address': 'Goa', 'opens': '2026-10-19T08:00:00+05:30'},
                 'lines': [{'name': 'Coffee', 'qty': 1, 'options': ['oat'], 'unitInr': 190, 'lineInr': 190}]}
        sent = {k: v for k, v in order.items() if k != 'operation'}
        sent['note'] = sent['note'].strip(bridge._JS_TRIM)  # the app saves the trimmed note in its preview
        payload = {'appId': 'forkicks', 'operation': 'forkicks.order.confirm', 'preview': {'appId': 'forkicks', 'draftId': draft, **sent, 'quote': quote, 'displayName': 'Priya'}}
        return {'draftId': draft, 'quote': quote, 'displayName': 'Priya', 'approvalPayload': payload,
                'payloadHash': hashlib.sha256(fk.canonical(payload).encode()).hexdigest()}

    def test_same_block_joiner_note_reaches_the_app(self):
        self.enable()
        # The check runs on the JS-trimmed note: a U+FEFF or U+2029 the app trims away is not refused (mutant M36).
        for n, note in enumerate((KA + VIRAMA + ZWJ + SSA, ' ' + KA + VIRAMA + ZWNJ + SSA + ' ',
                                  '\ufeff' + KA + VIRAMA + ZWJ + SSA + '\u2029')):
            with self.subTest(note=note.encode('unicode_escape').decode()):
                self.transport.reset_mock()
                order = self.order(note)
                self.transport.return_value = self.result_for(order, '550e8400-e29b-41d4-a716-44665544000%d' % n)
                self.assertIn('data', self.call(order))
                self.transport.assert_called_once()

    def test_other_joiners_and_format_characters_in_the_note_are_refused_at_prepare(self):
        self.enable()
        for note in ('Ab' + ZWJ + 'cd', KA + VIRAMA + ZWJ, ZWJ + KA, KA + ZWJ + ZWJ + SSA, KA + VIRAMA + '\u200b' + SSA, 'a\u202eb',
                     '\u0997' + ZWJ + KA):
            with self.subTest(note=note.encode('unicode_escape').decode()):
                response = self.call(self.order(note))
                self.assertEqual(response['error'], 'invalid_arguments')
                self.assertEqual(response['fields'], ['note'])
        self.transport.assert_not_called()


if __name__ == '__main__':
    unittest.main()
