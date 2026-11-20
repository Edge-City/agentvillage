"""FORKICKS-DOWN (19 Oct): a top-level `date` on forkicks.order.prepare, and every other argument error caught
before any request, is a closed invalid_arguments error the agent can correct, never village_unavailable."""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
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

# The catch-all's text, unchanged: network, upstream and uncertain-confirm failures still carry it.
UNAVAILABLE = ("Do not claim success. Recheck current meeting state after uncertainty. For a star use gold-stars.status "
               "with the same draftId; never prepare another to retry. For Kicks: use order.status with a returned "
               "orderId, or retry order.confirm with the SAME draftId and saved proof; never prepare another order "
               "after an uncertain confirm.")


class ForKicksInvalidArgumentsTest(unittest.TestCase):
    setUp = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def enable(self):
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        gate = patch.object(bridge, 'gate_verified', return_value=None); self.gate = gate.start(); self.addCleanup(gate.stop)

    def failing_call(self):
        """The shape of the 07:02:54Z call (codes and shapes only, no resident text): a top-level date, fulfilment
        {locationId, type: pickup} with no date, one item with an int qty and four optionIds, upi, a 23-character note."""
        return {'operation': 'forkicks.order.prepare', 'date': '2026-10-19',
                'fulfilment': {'locationId': 'cafe', 'type': 'pickup'},
                'items': [{'itemId': 'coffee', 'qty': 1, 'optionIds': ['oat', 'hot', 'large', 'less-sugar']}],
                'paymentMethod': 'upi', 'note': 'n' * 23}

    def result_for(self, order):
        draft = '550e8400-e29b-41d4-a716-446655440000'
        quote = {'quoteId': 'quote-1', 'canOrder': True, 'totalInr': 190, 'location': {'name': 'Cafe', 'address': 'Goa', 'opens': '2026-10-19T08:00:00+05:30'},
                 'lines': [{'name': 'Coffee', 'qty': 1, 'options': ['oat'], 'unitInr': 190, 'lineInr': 190}]}
        payload = {'appId': 'forkicks', 'operation': 'forkicks.order.confirm', 'preview': {'appId': 'forkicks', 'draftId': draft, **order, 'quote': quote, 'displayName': 'Priya'}}
        return {'draftId': draft, 'quote': quote, 'displayName': 'Priya', 'approvalPayload': payload,
                'payloadHash': hashlib.sha256(fk.canonical(payload).encode()).hexdigest()}

    def test_replayed_failing_call_reaches_the_app_with_fulfilment_date(self):
        self.enable()
        request = self.failing_call(); original = copy.deepcopy(request)
        sent = {k: v for k, v in request.items() if k not in ('operation', 'date')}
        sent['fulfilment'] = {'locationId': 'cafe', 'type': 'pickup', 'date': '2026-10-19'}
        result = self.result_for(sent); self.transport.return_value = result
        response = self.call(request)
        # FK-CARD-AT-PREPARE: the answer also carries the card's approval fields (no daemon here: not raised).
        self.assertEqual({k: response[k] for k in ('data', 'handling')}, {'data': result, 'handling': bridge.HANDLING})
        self.assertEqual(response['instruction'], mini.ORDER_CARD_NOT_RAISED)
        self.transport.assert_called_once_with(self.config, {'operation': 'forkicks.order.prepare', **sent})
        self.assertNotIn('date', self.transport.call_args.args[1])
        self.assertEqual(request, original)  # the model's own arguments are never mutated
        self.gate.assert_called_once()
        self.assertTrue(Path(self.tmp.name, 'forkicks-drafts', result['draftId'] + '.json').is_file())

    def test_equal_top_level_date_is_dropped(self):
        self.enable()
        request = self.failing_call(); request['fulfilment'] = {**request['fulfilment'], 'date': '2026-10-19'}
        sent = {k: v for k, v in request.items() if k not in ('operation', 'date')}
        self.transport.return_value = self.result_for(sent)
        self.assertIn('data', self.call(request))
        self.transport.assert_called_once_with(self.config, {'operation': 'forkicks.order.prepare', **sent})

    def test_conflicting_or_malformed_dates_are_invalid_arguments_and_nothing_is_sent(self):
        self.enable()
        conflict = self.failing_call(); conflict['fulfilment'] = {**conflict['fulfilment'], 'date': '2026-10-20'}
        response = self.call(conflict)
        self.assertEqual(response, {'error': 'invalid_arguments', 'fields': ['date'], 'instruction': bridge.FORKICKS_DATE_CONFLICT})
        self.assertNotIn('village_unavailable', json.dumps(response))
        for date in ['19 Oct', '2026-10-19T08:00', 20261019, None, '２０２６-10-19']:
            with self.subTest(date=date):
                response = self.call({**self.failing_call(), 'date': date})
                self.assertEqual(response['error'], 'invalid_arguments')
                self.assertEqual(response['fields'], ['date'])
                self.assertIn('fulfilment.date', response['instruction'])
        self.transport.assert_not_called(); self.gate.assert_not_called()
        self.assertFalse(Path(self.tmp.name, 'forkicks-drafts').exists())

    def test_unknown_keys_on_several_operations_are_invalid_arguments_with_an_instruction(self):
        draft = '550e8400-e29b-41d4-a716-446655440000'
        requests = [  # gold-stars (and its rolodex/skylight reads) is installed by the shared setUp
            {'operation': 'rolodex.search', 'query': 'Naman', 'humanId': 'other'},
            {'operation': 'gold-stars.quota', 'tenantId': 'other'},
            {'operation': 'gold-stars.send', 'draftId': draft, 'approval': {'approved': True}},
            {'operation': 'skylight.status', 'attendeeId': draft},
        ]
        for request in requests:
            with self.subTest(op=request['operation']):
                response = self.call(request)
                self.assertEqual(set(response), {'error', 'instruction'})
                self.assertEqual(response['error'], 'invalid_arguments')
                self.assertTrue(response['instruction'].startswith('Nothing was sent. ' + request['operation'] + ' accepts only: '))
                self.assertIn('call again', response['instruction'])
        self.enable()
        requests = [
            {**self.failing_call(), 'time': '10:00'},
            {'operation': 'forkicks.menu', 'url': 'https://example.test'},
            {'operation': 'forkicks.order.confirm', 'draftId': draft, 'approval': {'approved': True}},
            {'operation': 'forkicks.order.status', 'orderId': 'order-1', 'tenantId': 'other'},
        ]
        tail = '. Fix the arguments and call again; this is not an outage, so do not report the service as unavailable.'
        for request in requests:
            with self.subTest(op=request['operation']):
                response = self.call(request)
                self.assertEqual(response['error'], 'invalid_arguments')
                op = request['operation']
                if op == 'forkicks.order.prepare':  # field-aware: the unknown key is never echoed
                    self.assertEqual(response['fields'], ['(unknown field)'])
                    self.assertEqual(response['instruction'], 'Nothing was sent. Correct: (unknown field). ' + op + ' accepts only: ' + bridge.OP_ARGUMENTS[op] + tail)
                else:
                    self.assertNotIn('fields', response)
                    self.assertEqual(response['instruction'], 'Nothing was sent. ' + op + ' accepts only: ' + bridge.OP_ARGUMENTS[op] + tail)
        for request in [{'operation': 'forkicks.order.publish'}, {'operation': ['forkicks.menu']}]:
            response = self.call(request)
            self.assertEqual(response['error'], 'invalid_arguments')
            self.assertTrue(response['instruction'].startswith('Nothing was sent.'))
        self.transport.assert_not_called(); self.gate.assert_not_called()

    def test_prepare_errors_name_only_schema_fields_never_values(self):
        # Adapted from jmill's ov#407 field-aware tests.
        self.enable()
        order = self.failing_call()
        for field, value in [('items', 'private-value'), ('items', []), ('fulfilment', 17), ('paymentMethod', 'private-value'),
                             ('paymentMethod', 'cash'), ('note', 'x' * 141), ('note', 7)]:
            with self.subTest(field=field, value=str(value)[:10]):
                response = self.call({**order, field: value})
                self.assertEqual(response['error'], 'invalid_arguments')
                # With no fulfilment object to move it into, the top-level date is named too.
                self.assertEqual(response['fields'], ['date', 'fulfilment'] if field == 'fulfilment' else [field])
                self.assertNotIn('private-value', json.dumps(response))
        missing = dict(order); del missing['paymentMethod']
        self.assertEqual(self.call(missing)['fields'], ['paymentMethod'])
        response = self.call({**order, 'private-key': 1, 'locationId': 'cafe'})
        self.assertEqual(response['fields'], ['(unknown field)', 'locationId'])
        self.assertNotIn('private-key', json.dumps(response))
        # The app trims the note before its 140 limit, so surrounding spaces do not count.
        sent = {k: v for k, v in order.items() if k not in ('operation', 'date')}
        sent['fulfilment'] = {**sent['fulfilment'], 'date': '2026-10-19'}
        sent['note'] = ' ' + 'x' * 140 + ' '
        self.transport.return_value = self.result_for(sent)
        self.assertIn('data', self.call({**order, 'note': sent['note']}))
        self.transport.assert_called_once()

    def test_errors_after_a_request_was_sent_keep_village_unavailable_and_its_instruction(self):
        self.enable()
        # A ValueError while reading the app's answer (a JSON parse error is a ValueError) ...
        self.transport.side_effect = ValueError('Expecting value')
        response = self.call(self.failing_call())
        self.assertEqual(response, {'error': 'village_unavailable', 'settingsUrl': bridge.SETTINGS, 'instruction': UNAVAILABLE})
        self.transport.assert_called_once()
        # ... and one raised after the answer arrived (a forged payload hash refused while caching the preview).
        self.transport.reset_mock(); self.transport.side_effect = None
        sent = {k: v for k, v in self.failing_call().items() if k not in ('operation', 'date')}
        sent['fulfilment'] = {**sent['fulfilment'], 'date': '2026-10-19'}
        result = self.result_for(sent); result['payloadHash'] = 'f' * 64; self.transport.return_value = result
        response = self.call(self.failing_call())
        self.assertEqual(response, {'error': 'village_unavailable', 'settingsUrl': bridge.SETTINGS, 'instruction': UNAVAILABLE})
        self.transport.assert_called_once()
        self.assertFalse(Path(self.tmp.name, 'forkicks-drafts').exists())

    def test_gate_still_refuses_a_corrected_prepare(self):
        self.enable(); self.gate.side_effect = ValueError('approval_unavailable')
        response = self.call(self.failing_call())
        self.assertEqual(response['error'], 'approval_unavailable')
        self.assertIn('Do not claim an order was prepared.', response['instruction'])
        self.transport.assert_not_called()

    def test_schema_routes_the_pickup_date_into_fulfilment_and_stays_a_literal(self):
        fields = bridge.SCHEMA['parameters']['properties']
        self.assertTrue(fields['date']['description'].startswith('forkicks.menu only'))
        self.assertIn('fulfilment.date', fields['date']['description'])
        self.assertEqual(fields['date']['type'], 'string')
        self.assertEqual(fields['fulfilment']['properties']['date']['type'], 'string')
        self.assertEqual(fields['fulfilment']['required'], ['type', 'locationId'])
        self.assertIs(fields['fulfilment']['additionalProperties'], False)
        # The R-DEON proof (scripts/tests/rdeon-haiku-proof.test.ts) reads SCHEMA with ast.literal_eval.
        tree = ast.parse(Path(bridge.__file__).read_text(encoding='utf-8'))
        literal = [ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', None) == 'SCHEMA']
        self.assertEqual(literal, [bridge.SCHEMA])


if __name__ == '__main__': unittest.main()
