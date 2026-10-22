"""The For Kicks flat order card (Carter P0, 21 Oct; v2.1.10 hotfix): the box accepts the app's legacy payload
{appId, operation, preview} AND the four-key {order, total, pickup, name}, re-derives the four strings from the
order preview the app returned beside the payload at prepare, refuses any difference, and proposes the app's payload
byte for byte under For Kicks' member class marketplace.app.action.forkicks.order.confirm and its per-draftId key
(autonomy sequence step 1). Spec + golden vectors: tests/vectors/."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
import unittest.mock
from unittest.mock import Mock, patch
# pytest.ini's --import-mode=importlib keeps tests/ off sys.path, so load the shared fixture by path (once).
fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']

VECTORS = json.loads(Path(__file__).with_name('vectors').joinpath('forkicks-approval-card.json').read_text(encoding='utf-8'))
MEMBER = 'marketplace.app.action.forkicks.order.confirm'
KEY = MEMBER + ':'


def answer(**doc):
    return types.SimpleNamespace(ok=doc.get('ok') is True, doc=doc, exit_code=0, status=doc.get('status'))


def vector(name):
    return copy.deepcopy(next(v for v in VECTORS['vectors'] if v['name'].startswith(name)))


def hashed(payload):
    return hashlib.sha256(fk.canonical(payload).encode()).hexdigest()


class GoldenVectorTest(unittest.TestCase):
    def test_every_golden_vector(self):
        self.assertEqual(VECTORS['valueMax'], fk.CARD_VALUE_MAX)
        self.assertGreaterEqual(len(VECTORS['vectors']), 10)
        for v in VECTORS['vectors']:
            with self.subTest(v['name']):
                if 'card' in v:
                    self.assertEqual(fk.card_fields(v['preview']), v['card'])
                else:
                    with self.assertRaisesRegex(ValueError, '^' + v['error'] + '$'):
                        fk.card_fields(v['preview'])

    def test_target_card_text(self):
        self.assertEqual(fk.card_fields(vector('target-card')['preview']), {
            'order': '1 × Iced latte (Oat milk, Miso caramel syrup)', 'total': '₹0, pay by UPI',
            'pickup': 'For Kicks Mandrem · 21 Oct 2026', 'name': 'Alex'})

    def test_every_line_is_listed_uncut(self):
        p = vector('two lines')['preview']
        self.assertEqual(fk.card_fields(p)['order'], '2 × Cold brew (Oat milk, Large)\n1 × Butter croissant')
        p['quote']['lines'] *= 3; p['items'] *= 3
        self.assertEqual(fk.card_fields(p)['order'].count(' × '), 6)

    def test_one_item_per_line_and_no_text_breaks_a_line(self):
        # product + lead L17778: one item per line; separators inside a name are fine, a line break of its own is not.
        self.assertEqual(vector('parentheses inside an item name')['card']['order'], '1 × Latte (oat)')
        self.assertEqual(vector('a comma inside an item name')['card']['order'], '1 × Iced, oat (Large)\n2 × Latte; 5 × Cake')
        self.assertEqual(vector('accents pass')['card']['order'], '1 × Crème brûlée (Extra-crispy)')
        self.assertEqual(vector('a delivery address with a comma')['error'], 'approval_card_not_minimal')  # pickup only today
        for name in ('a carriage return', 'a line separator U+2028', 'a bidi override in an item', 'a newline in an item name',
                     'a zero-width space', 'a newline in the name', 'a left-to-right mark'):
            self.assertEqual(vector(name)['error'], 'approval_card_invalid', name)
        for name in ('a return symbol in an item name', 'a pickup place that starts like the delivery form',
                     'a pickup place starting delivery TO', 'a full-width DELIVERY prefix', 'a no-break space in an option'):
            self.assertEqual(vector(name)['error'], 'approval_card_not_minimal', name)
        base = vector('target-card')['preview']
        for bad in '\n\r\u2028\u2029\u202e\u2066\u200b\u0085\x0b\x0c':
            p = copy.deepcopy(base); p['quote']['lines'][0]['name'] = 'Iced' + bad + 'latte'
            with self.assertRaises(ValueError, msg=repr(bad)):
                fk.card_fields(p)
        for name in ('a pickup place containing a middle dot', 'a delivery address with a Greek ano teleia',
                     'a return arrow in an item name', 'a control picture in an option', 'a halfwidth arrow'):
            self.assertEqual(vector(name)['error'], 'approval_card_not_minimal', name)
        for arrow in '\u23ce\u2190\u21b5\u21ff\u2400\u243f\u27f0\u2936\u2b0e\uffe9':
            p = copy.deepcopy(base); p['quote']['lines'][0]['options'] = ['Oat ' + arrow]
            with self.assertRaisesRegex(ValueError, '^approval_card_not_minimal$', msg=repr(arrow)):
                fk.card_fields(p)
        for name in ('a delivery order', 'a delivery address with a comma'):  # review-b ov#446 S1: pickup only today
            self.assertEqual(vector(name)['error'], 'approval_card_not_minimal', name)
        p = copy.deepcopy(vector('target-card')['preview'])
        p['fulfilment'] = {'type': 'delivery', 'locationId': p['fulfilment']['locationId'], 'date': '2026-10-22', 'deliveryAddress': 'Room 12 \ua78f 25 Dec 2026'}
        with self.assertRaisesRegex(ValueError, '^approval_card_not_minimal$'):
            fk.card_fields(p)  # review-b's lookalike date in an agent-written address never reaches a flat card
        self.assertIn('card', vector('two lines drawing exactly 278'))
        self.assertEqual(vector('two lines drawing 279')['error'], 'approval_card_not_minimal')

    def test_budget_edge_is_exactly_core_value_max(self):
        self.assertIn('card', vector('exactly 278')); self.assertEqual(len(vector('exactly 278')['card']['order']), 278)
        for n in ('279', '280', '281'):
            self.assertEqual(vector(n + ' code points')['error'], 'approval_card_not_minimal')


class FlatCardBoxTest(unittest.TestCase):
    setUp = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def enable(self):
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        gate = patch.object(bridge, 'gate_verified', return_value=None); gate.start(); self.addCleanup(gate.stop)

    def app_answer(self, name='target-card', shape='flat'):
        """The app's prepare answer: a flat payload with the order preview beside it, or today's legacy payload."""
        v = vector(name)
        preview = v['preview']
        payload = v['card'] if shape == 'flat' else {'appId': 'forkicks', 'operation': 'forkicks.order.confirm', 'preview': preview}
        result = {'draftId': preview['draftId'], 'quote': preview['quote'], 'displayName': preview['displayName'],
                  'approvalPayload': payload, 'payloadHash': hashed(payload)}
        if shape == 'flat':
            result['preview'] = preview
        return result

    def args(self, result):
        # The agent's prepare arguments; the box never derives the card from them (the app's answer is what counts).
        return {'operation': 'forkicks.order.prepare', 'items': [{'itemId': 'item-0', 'qty': 1, 'optionIds': []}],
                'fulfilment': {'type': 'pickup', 'locationId': 'mandrem'}, 'paymentMethod': 'upi'}

    def prepare(self, result, extra=None):
        self.enable()
        self.transport.return_value = result
        response = self.call({**self.args(result), **(extra or {})})
        self.transport.reset_mock()
        self.transport.return_value = {'orderId': 'order-1', 'number': '#042', 'payment': {'simulated': True, 'label': 'Test payment, no money moved'}}
        return response

    def refused(self, result, code):
        """The box's own refusal code, and through the tool: no draft is cached (the tool says village_unavailable)."""
        with self.assertRaisesRegex(ValueError, '^' + code + '$'):
            fk.checked_payload(result.get('approvalPayload'), result['draftId'], result.get('payloadHash'), result.get('preview'))
        self.assertEqual(self.prepare(result)['error'], 'village_unavailable')
        self.assertFalse(self.record_path(result['draftId']).exists())

    def daemon(self, decision='requested'):
        ap = Mock()
        ap.propose.side_effect = lambda cls, key, summary, payload: answer(ok=True, task='propose:' + 'a' * 32, decision=decision, state='granted', payload_hash=hashlib.sha256(payload.encode()).hexdigest())
        ap.wait.return_value = answer(status='granted')
        ap.start.return_value = answer(ok=True, authorization='grant')
        return ap

    def next_turn(self):
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')

    def record_path(self, draft):
        return Path(self.tmp.name, 'forkicks-drafts', draft + '.json')

    def confirm(self, draft, ap):
        with patch.object(fk, 'approval_modules', return_value=ap):
            return self.call({'operation': 'forkicks.order.confirm', 'draftId': draft})

    def test_flat_payload_is_saved_with_its_preview_and_proposed_byte_for_byte_under_the_member_class_and_key(self):
        result = self.app_answer()
        response = self.prepare(result); self.assertEqual(response.get('data'), result, response)
        record = json.loads(self.record_path(result['draftId']).read_text())
        self.assertEqual(record['payload'], result['approvalPayload']); self.assertEqual(record['preview'], result['preview'])
        self.next_turn(); ap = self.daemon()
        self.assertIn('data', self.confirm(result['draftId'], ap))
        cls, key, summary, held = ap.propose.call_args.args
        self.assertEqual((cls, key), (MEMBER, KEY + result['draftId']))
        self.assertEqual(held, fk.canonical(result['approvalPayload']))  # the app's payload, exactly
        self.assertEqual(sorted(json.loads(held)), ['name', 'order', 'pickup', 'total'])
        self.assertEqual(summary, fk.approval_summary({'preview': result['preview']}))  # the technical card's text, from the saved order
        sent = self.transport.call_args.args[1]
        self.assertEqual(sent['approval'], {'taskId': 'propose:' + 'a' * 32, 'payloadHash': result['payloadHash'], 'payload': result['approvalPayload']})
        ap.start.assert_called_once_with('propose:' + 'a' * 32, KEY + result['draftId'], held)

    def test_legacy_payload_still_confirms_unchanged(self):
        result = self.app_answer(shape='legacy')
        self.prepare(result)
        self.assertNotIn('preview', json.loads(self.record_path(result['draftId']).read_text()))
        self.next_turn(); ap = self.daemon()
        self.assertIn('data', self.confirm(result['draftId'], ap))
        cls, key, summary, held = ap.propose.call_args.args
        self.assertEqual((cls, key, held), (MEMBER, KEY + result['draftId'], fk.canonical(result['approvalPayload'])))
        self.assertEqual(summary, fk.approval_summary(result['approvalPayload']))

    def test_flat_strings_that_differ_from_the_saved_order_are_refused_and_never_cached(self):
        for field, value in [('order', '1 × Iced latte'), ('total', '₹0, card at pickup'), ('pickup', 'Elsewhere · 21 Oct 2026'),
                             ('name', 'Someone else'), ('order', '1 × Iced latte (Oat milk, Miso caramel syrup) ')]:
            with self.subTest(field=field):
                result = self.app_answer()
                result['approvalPayload'][field] = value
                result['payloadHash'] = hashed(result['approvalPayload'])  # a consistent hash: only the words differ
                self.refused(result, 'approval_card_invalid')
        result = self.app_answer()
        result['preview']['quote']['totalInr'] = 5  # the order beside the payload says otherwise
        self.refused(result, 'approval_card_invalid')

    def test_flat_payload_needs_its_own_drafts_preview_and_exactly_four_keys(self):
        cases = []
        r = self.app_answer(); del r['preview']; cases.append(r)
        r = self.app_answer(); r['preview']['draftId'] = 'other-draft'; cases.append(r)
        r = self.app_answer(); r['approvalPayload']['appId'] = 'forkicks'; r['payloadHash'] = hashed(r['approvalPayload']); cases.append(r)
        r = self.app_answer(); del r['approvalPayload']['name']; r['payloadHash'] = hashed(r['approvalPayload']); cases.append(r)
        r = self.app_answer(); r['payloadHash'] = 'f' * 64; cases.append(r)
        for result in cases:
            self.refused(result, 'approval_preview_unavailable')

    def test_agent_supplied_order_or_total_never_reaches_the_card(self):
        result = self.app_answer()
        # In the prepare arguments: refused before any request, so nothing is cached.
        for extra in ({'order': '1 × Free latte'}, {'total': '₹0'}, {'order': 'x', 'total': 'y', 'pickup': 'z', 'name': 'w'}):
            self.enable(); self.transport.return_value = result
            out = self.call({**self.args(result), **extra})
            self.assertIn('error', out); self.transport.assert_not_called()
            self.assertFalse(self.record_path(result['draftId']).exists())
        # In the confirm arguments: refused; the proposal is only ever the saved app payload.
        self.prepare(result); self.next_turn(); ap = self.daemon()
        with patch.object(fk, 'approval_modules', return_value=ap):
            out = self.call({'operation': 'forkicks.order.confirm', 'draftId': result['draftId'], 'order': '1 × Free latte', 'total': '₹0'})
        self.assertIn('error', out); ap.propose.assert_not_called(); self.transport.assert_not_called()
        # The saved record edited after prepare (a different order beside the same payload): refused at confirm.
        path = self.record_path(result['draftId'])
        record = json.loads(path.read_text()); record['preview']['quote']['lines'][0]['name'] = 'Free latte'
        path.write_text(json.dumps(record))
        out = self.confirm(result['draftId'], ap)
        self.assertEqual(out['error'], 'approval_preview_unavailable'); ap.propose.assert_not_called()

    def test_an_order_over_the_card_budget_is_never_cut(self):
        long = vector('over the card budget')
        self.assertEqual(long['error'], 'approval_card_not_minimal')
        # The app (by the spec) sends the legacy shape: accepted, every line in the technical card's summary.
        result = self.app_answer('over the card budget', shape='legacy')
        self.prepare(result); self.next_turn(); ap = self.daemon()
        self.assertIn('data', self.confirm(result['draftId'], ap))
        held, summary = ap.propose.call_args.args[3], ap.propose.call_args.args[2]
        self.assertEqual(json.loads(held), result['approvalPayload'])
        for i in range(1, 7):
            self.assertIn(f'Seasonal special number {i}', summary)
        # The 280- and 281-code-point drafts (approval L17750's edge) arrive legacy too and are accepted.
        for n in ('280', '281'):
            result = self.app_answer(n + ' code points', shape='legacy')
            self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
            self.prepare(result); self.next_turn(); ap = self.daemon()
            self.assertIn('data', self.confirm(result['draftId'], ap))
            self.assertEqual(json.loads(ap.propose.call_args.args[3]), result['approvalPayload'])
        # A flat payload carrying the over-budget order uncut is refused, and a cut one is a mismatch (a fresh draftId:
        # the legacy one above is saved).
        p = dict(long['preview'], draftId='d-long-flat')
        lines = '\n'.join(f'{l["qty"]} × {l["name"]} ({", ".join(l["options"])})' for l in p['quote']['lines'])
        for order in (lines, lines[:fk.CARD_VALUE_MAX - 1] + '…'):
            payload = {'order': order, 'total': '₹1800, pay by UPI', 'pickup': 'For Kicks Mandrem · 21 Oct 2026', 'name': 'Alex'}
            self.refused({'draftId': p['draftId'], 'approvalPayload': payload, 'payloadHash': hashed(payload), 'preview': p},
                         'approval_card_not_minimal')

    def test_a_note_travels_unshown_on_the_four_row_card_known_gap(self):
        # KNOWN GAP accepted by Carter (lead L17772, 21 Oct): the note is not on the flat card.
        v = vector('a note travels UNSHOWN')
        self.assertEqual(sorted(v['card']), ['name', 'order', 'pickup', 'total'])
        result = self.app_answer('a note travels UNSHOWN')
        response = self.prepare(result); self.assertEqual(response.get('data'), result, response)
        self.next_turn(); ap = self.daemon()
        self.assertIn('data', self.confirm(result['draftId'], ap))
        self.assertEqual(ap.propose.call_args.args[3], fk.canonical(v['card']))
        self.assertIn('Note: "No sugar please"', ap.propose.call_args.args[2])  # in Full details (the technical card's text)
        extra = {**v['card'], 'note': 'No sugar please'}  # no fifth row in this hotfix
        self.refused({'draftId': 'd-five', 'approvalPayload': extra, 'payloadHash': hashed(extra),
                      'preview': {**v['preview'], 'draftId': 'd-five'}}, 'approval_preview_unavailable')

    def test_every_unshown_order_field_refuses_the_flat_card(self):
        for name in ('a delivery address on a pickup', 'item ids that differ'):
            v = vector(name)
            self.assertEqual(v['error'], 'approval_card_invalid')
        base = vector('target-card')['preview']
        mutations = [
            lambda p: p['items'][0].__setitem__('extra', 1),
            lambda p: p['fulfilment'].__setitem__('instructions', 'leave at gate'),
            lambda p: p['quote']['location'].__setitem__('id', 'elsewhere'),
            lambda p: p['quote'].__setitem__('locationId', 'elsewhere'),
            lambda p: p['quote']['lines'][0].__setitem__('itemId', 'other'),
        ]
        for mutate in mutations:
            p = copy.deepcopy(base); mutate(p)
            with self.assertRaisesRegex(ValueError, '^approval_card_invalid$'):
                fk.card_fields(p)

    def legacy_after_flat(self, flat):
        """The app's answer to the re-prepare without the header: a NEW draft in the legacy shape."""
        preview = dict(flat['preview'], draftId=flat['draftId'] + '-legacy')
        payload = {'appId': 'forkicks', 'operation': 'forkicks.order.confirm', 'preview': preview}
        return {'draftId': preview['draftId'], 'quote': preview['quote'], 'displayName': preview['displayName'],
                'approvalPayload': payload, 'payloadHash': hashed(payload)}

    def test_a_flat_card_the_box_cannot_derive_is_prepared_again_in_the_legacy_shape(self):
        # review-b app#516 S1, lead L17847: the app's Unicode tables can be newer than this box's; the order still goes through.
        cases = [('a card string that differs', 'approval_card_invalid')]
        if fk.unicodedata.category('\U0001FA77') == 'Cn':  # unassigned in this Python (3.11: Unicode 14), assigned in Unicode 15
            cases.insert(0, ('a Unicode 15 name', 'approval_card_not_minimal'))
        for n, (label, code) in enumerate(cases):
            with self.subTest(label):
                self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
                flat = self.app_answer()
                flat['draftId'] = flat['preview']['draftId'] = f'd-fb-{n}'
                if code == 'approval_card_not_minimal':
                    flat['preview']['displayName'] = 'Sam\U0001FA77'
                    flat['approvalPayload'] = {**flat['approvalPayload'], 'name': 'Sam\U0001FA77'}
                else:
                    flat['approvalPayload'] = {**flat['approvalPayload'], 'order': '1 × Free latte'}
                flat['payloadHash'] = hashed(flat['approvalPayload'])
                legacy = self.legacy_after_flat(flat)
                self.enable(); self.transport.reset_mock(); self.transport.side_effect = [flat, legacy]
                with self.assertLogs('village_bridge', 'WARNING') as logs:
                    out = self.call(self.args(flat))
                self.assertEqual(out.get('data'), legacy, out)  # the agent only ever sees the legacy draft
                self.assertEqual([c.kwargs for c in self.transport.call_args_list], [{}, {'flat_card': False}])
                self.assertEqual(self.transport.call_args_list[0].args, self.transport.call_args_list[1].args)
                self.assertEqual(logs.output, ['WARNING:village_bridge:village_bridge forkicks card_fallback_legacy code=' + code])
                self.assertFalse(self.record_path(flat['draftId']).exists())  # the card draft is never saved
                self.assertEqual(json.loads(self.record_path(legacy['draftId']).read_text())['payload'], legacy['approvalPayload'])
                self.transport.side_effect = None; self.transport.reset_mock()
                self.transport.return_value = {'orderId': 'order-1', 'number': '#042', 'payment': {'simulated': True, 'label': 'Test payment, no money moved'}}
                self.next_turn(); ap = self.daemon()
                self.assertIn('data', self.confirm(legacy['draftId'], ap))
                self.assertEqual(json.loads(ap.propose.call_args.args[3]), legacy['approvalPayload'])
                self.assertEqual(self.transport.call_count, 1)  # the confirm itself; never a re-prepare
                self.assertEqual(self.transport.call_args.args[1]['draftId'], legacy['draftId'])
                # The card draft cannot be confirmed through this box.
                ap = self.daemon()
                self.assertEqual(self.confirm(flat['draftId'], ap)['error'], 'approval_preview_unavailable'); ap.propose.assert_not_called()

    def test_the_fallback_runs_once_never_for_a_bad_hash_and_never_on_confirm(self):
        flat = self.app_answer(); flat['approvalPayload'] = {**flat['approvalPayload'], 'order': 'x'}; flat['payloadHash'] = hashed(flat['approvalPayload'])
        self.enable(); self.transport.side_effect = [flat, flat]  # the app answers flat again: a second failure raises
        self.assertEqual(self.call(self.args(flat))['error'], 'village_unavailable')
        self.assertEqual(self.transport.call_count, 2); self.assertFalse(self.record_path(flat['draftId']).exists())
        self.transport.reset_mock(); self.transport.side_effect = None
        forged = self.app_answer(); forged['payloadHash'] = 'f' * 64
        self.transport.return_value = forged
        self.assertEqual(self.call(self.args(forged))['error'], 'village_unavailable')
        self.assertEqual(self.transport.call_count, 1)  # approval_preview_unavailable: no second prepare
        # A record tampered after a good prepare: refused at confirm, nothing prepared again.
        good = self.app_answer(); self.transport.reset_mock(); self.transport.return_value = good
        self.call(self.args(good)); path = self.record_path(good['draftId'])
        record = json.loads(path.read_text()); record['payload']['order'] = '1 × Free latte'; path.write_text(json.dumps(record))
        self.transport.reset_mock(); self.next_turn(); ap = self.daemon()
        self.assertEqual(self.confirm(good['draftId'], ap)['error'], 'approval_preview_unavailable')
        self.transport.assert_not_called(); ap.propose.assert_not_called()

    def test_card_strings_compare_byte_for_byte_never_normalised(self):
        # review-b ov#446 N2: an NFD payload for an NFC order (or the reverse) is a mismatch, never "the same text".
        import unicodedata
        nfc = vector('accents pass')
        nfd_payload = {k: unicodedata.normalize('NFD', x) for k, x in nfc['card'].items()}
        self.assertNotEqual(nfd_payload, nfc['card'])
        with self.assertRaisesRegex(ValueError, '^approval_card_invalid$'):
            fk.checked_payload(nfd_payload, nfc['preview']['draftId'], hashed(nfd_payload), nfc['preview'])
        nfd_preview = copy.deepcopy(nfc['preview'])
        for line in nfd_preview['quote']['lines']:
            line['name'] = unicodedata.normalize('NFD', line['name'])
        with self.assertRaisesRegex(ValueError, '^approval_card_invalid$'):
            fk.checked_payload(nfc['card'], nfc['preview']['draftId'], hashed(nfc['card']), nfd_preview)
        self.assertEqual(fk.checked_payload(nfc['card'], nfc['preview']['draftId'], hashed(nfc['card']), nfc['preview']), fk.canonical(nfc['card']))

    def test_flat_card_refused_unless_the_daemon_says_requested(self):
        result = self.app_answer()
        self.prepare(result); self.next_turn()
        for decision in ('autonomous', 'supervised', 'granted', None):
            ap = self.daemon(decision=decision)
            self.assertEqual(self.confirm(result['draftId'], ap)['error'], 'approval_refused')
            ap.wait.assert_not_called(); ap.start.assert_not_called()
        ap = self.daemon(); ap.propose.side_effect = lambda *a: answer(ok=True, task='propose:' + 'a' * 32, decision='requested', payload_hash='0' * 64)
        self.assertEqual(self.confirm(result['draftId'], ap)['error'], 'approval_refused')
        self.transport.assert_not_called()

    def test_one_key_per_draft_and_a_replayed_prepare_cannot_change_the_card(self):
        result = self.app_answer()
        self.prepare(result)
        before = self.record_path(result['draftId']).read_bytes()
        # Same draft, other shape or other words: refused, the first record stays.
        legacy = self.app_answer(shape='legacy')
        self.assertEqual(self.prepare(legacy)['error'], 'village_unavailable')
        self.prepare(result)  # an identical replay is fine
        self.assertEqual(self.record_path(result['draftId']).read_bytes(), before)
        self.next_turn(); ap = self.daemon()
        self.confirm(result['draftId'], ap); self.confirm(result['draftId'], ap)
        self.assertEqual({c.args[1] for c in ap.propose.call_args_list}, {KEY + result['draftId']})
        self.assertEqual({c.args[3] for c in ap.propose.call_args_list}, {fk.canonical(result['approvalPayload'])})


class FlatCardHeaderTest(unittest.TestCase):
    """The app emits the four-key payload only for a box that says it accepts it (context L17737)."""
    def test_prepare_alone_carries_the_flat_card_header(self):
        response = unittest.mock.MagicMock(); response.__enter__.return_value = response; response.read.return_value = b'{}'
        opener = Mock(); opener.open.return_value = response
        config = {'origin': 'https://agents.edgecity.live', 'token': 'not-logged'}
        with patch.object(bridge, 'build_opener', return_value=opener):
            fixture.real_transport(config, {'operation': 'forkicks.order.prepare', 'items': [], 'fulfilment': {}, 'paymentMethod': 'upi'})
            self.assertEqual(opener.open.call_args.args[0].get_header('X-village-forkicks-card'), '1')
            fixture.real_transport(config, {'operation': 'forkicks.order.prepare', 'items': [], 'fulfilment': {}, 'paymentMethod': 'upi'}, flat_card=False)
            self.assertIsNone(opener.open.call_args.args[0].get_header('X-village-forkicks-card'))  # the legacy re-prepare
            for other in [{'operation': 'forkicks.order.confirm', 'draftId': 'd'}, {'operation': 'forkicks.order.status', 'orderId': 'o'},
                          {'operation': 'forkicks.menu'}, {'operation': 'forkicks.schedule'}, {'operation': 'forkicks.order.cancel', 'orderId': 'o'},
                          {'operation': 'gold-stars.prepare'}, {'operation': 'slopfolio.prepare'}]:
                fixture.real_transport(config, other)
                self.assertIsNone(opener.open.call_args.args[0].get_header('X-village-forkicks-card'), other['operation'])


if __name__ == '__main__': unittest.main()
