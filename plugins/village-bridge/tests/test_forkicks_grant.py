"""FK-ON-GRANT: the For Kicks order is placed on the resident's grant by av-events' approval poller pass,
and one plain line goes to the owner's own DM. Offline: a fake daemon, a fake app, no Telegram."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import Mock, patch

fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']
grant = sys.modules['village_bridge._forkicks_grant']
ENSURE = bridge._ensure_forkicks_pass  # the real one (setUp patches it)

DRAFT = '550e8400-e29b-41d4-a716-446655440000'
TASK = 'propose:' + 'a' * 32
KEY = 'marketplace.app.action:forkicks.order.confirm:' + DRAFT
RECEIPT = {'orderId': 'order-1', 'number': '#042', 'status': 'queued', 'paymentStatus': 'pay_at_pickup', 'totalInr': 380,
           'payment': {'method': 'card_on_pickup', 'payee': 'For Kicks', 'amountInr': 380}}
PLACED = 'Approved: your For Kicks order is placed. Pickup: Café Mandrem · Mon 19 Oct, 08:00–18:00.'


def answer(exit_code=0, **doc):
    return types.SimpleNamespace(ok=exit_code == 0 and doc.get('ok') is True, doc=doc, exit_code=exit_code, status=doc.get('status'))


def granted(key=KEY, status='granted', state='granted'):
    return answer(0, ok=True, task=TASK, status=status, actions=[{'action_key': key, 'state': state, 'seq': 3}])


class Daemon:
    """approval.md as the box sees it: one task per key; a start spends the grant once."""

    def __init__(self):
        self.state = 'requested'  # requested | granted | started | <final status>
        self.propose = Mock(side_effect=self._propose)
        self.wait = Mock(side_effect=self._wait)
        self.start = Mock(side_effect=self._start)
        self.authorization = 'grant'

    def _propose(self, cls, key, summary, payload):
        return answer(0, ok=True, task=TASK, decision='requested', state='executed' if self.state == 'started' else None,
                      payload_hash=hashlib.sha256(payload.encode()).hexdigest())

    def _wait(self, task):
        if self.state == 'requested':
            return answer(6, ok=False, task=task, status='requested')
        if self.state == 'granted':
            return granted()
        if self.state == 'started':
            return granted(status='nothing-to-wait-for')
        code = {'rejected': 1, 'revoked': 1, 'withdrawn': 1, 'expired': 3, 'void': 7}[self.state]
        return answer(code, ok=True, task=task, status=self.state, actions=[{'action_key': KEY, 'state': self.state}])

    def _start(self, task, key, held):
        if self.state != 'granted':
            return answer(1, ok=False, error={'code': 'not-granted'})
        self.state = 'started'
        return answer(0, ok=True, task=task, action_key=key, authorization=self.authorization, seq=4)


class App:
    """The app's confirm: idempotent on the draft id, one in-flight confirm (the lease), receipts replay."""

    def __init__(self, test):
        self.test, self.orders, self.leased, self.during = test, 0, False, None

    def __call__(self, config, payload):
        if payload['operation'] != 'forkicks.order.confirm':
            return self.test.prepared
        if self.leased:
            return {'error': 'forkicks_confirm_in_progress', 'retryable': True}
        self.leased = True
        try:
            if self.during is not None:
                during, self.during = self.during, None
                during()
            if self.orders == 0:
                self.orders = 1
            return dict(RECEIPT)
        finally:
            self.leased = False


class ForKicksOnGrantTest(unittest.TestCase):
    setUp_bridge = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def setUp(self):
        self.setUp_bridge()
        self.home = Path(self.tmp.name)
        (self.home / 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        for target, value in ((bridge, 'gate_verified'), (bridge, '_ensure_forkicks_pass')):
            p = patch.object(target, value, return_value=True if value == '_ensure_forkicks_pass' else None)
            p.start(); self.addCleanup(p.stop)
        self.daemon = Daemon()
        for module in (fk, grant):
            p = patch.object(module, 'approval_modules', return_value=self.daemon)
            p.start(); self.addCleanup(p.stop)
        self.sent = []
        p = patch.object(grant, '_telegram_dm', side_effect=lambda owner, text: self.sent.append((owner, text)) or True)
        p.start(); self.addCleanup(p.stop)
        self.events = []
        grant.set_emitter(self.events.append); self.addCleanup(grant.set_emitter, None)
        self.app = App(self)
        self.transport.side_effect = self.app

    def preview(self, draft=DRAFT, expires='2099-01-01T00:00:00+05:30', shape='legacy'):
        """The app's prepare answer. `legacy`: today's {appId, operation, preview} payload. `flat`: the four-key card
        payload {order, total, pickup, name} with the order preview BESIDE it (part A, ov#446)."""
        order = {'items': [{'itemId': 'coffee', 'qty': 2, 'optionIds': ['oat']}], 'fulfilment': {'type': 'pickup', 'locationId': 'cafe', 'date': '2026-10-19'}, 'paymentMethod': 'card_on_pickup'}
        quote = {'quoteId': 'quote-1', 'expiresAt': expires, 'canOrder': True, 'totalInr': 380,
                 'location': {'name': 'Café Mandrem', 'address': 'Mandrem, Goa', 'opens': '2026-10-19T08:00:00+05:30', 'closes': '2026-10-19T18:00:00+05:30'},
                 'lines': [{'name': 'Coffee', 'qty': 2, 'options': ['oat milk'], 'unitInr': 190, 'lineInr': 380}]}
        if shape == 'flat':
            # The flat card binds each quote line to its item (itemId/optionIds), as the app's quote carries them.
            quote['lines'][0].update({'itemId': 'coffee', 'optionIds': ['oat']})
        preview = {'appId': 'forkicks', 'draftId': draft, **order, 'quote': quote, 'displayName': 'Priya'}
        payload = fk.card_fields(preview) if shape == 'flat' else {'appId': 'forkicks', 'operation': 'forkicks.order.confirm', 'preview': preview}
        result = {'draftId': draft, 'quote': quote, 'approvalPayload': payload, 'payloadHash': hashlib.sha256(fk.canonical(payload).encode()).hexdigest()}
        if shape == 'flat':
            result['preview'] = preview
        return result, order

    def ask(self, expires='2099-01-01T00:00:00+05:30', shape='legacy', confirm=True):
        """Prepare in one turn, confirm in the next: the card is sent and not tapped yet. Without `confirm`, only the
        prepare (which raises and tracks the card): the pass reaches the draft before any confirm of the agent."""
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
        self.prepared, order = self.preview(expires=expires, shape=shape)
        self.assertIn('data', self.call({'operation': 'forkicks.order.prepare', **order}))
        if not confirm:
            self.daemon.wait.reset_mock()
            return None
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')
        self.transport.reset_mock()
        response = self.call({'operation': 'forkicks.order.confirm', 'draftId': DRAFT})
        self.daemon.wait.reset_mock()  # the agent's own once-read; the pass's reads are counted from here
        return response

    def run_pass(self):
        bridge._forkicks_grant_pass()

    def marker(self, suffix='.await'):
        return self.home / 'forkicks-drafts' / (DRAFT + suffix)

    def confirms(self):
        return [c for c in self.transport.call_args_list if c.args[1]['operation'] == 'forkicks.order.confirm']

    # ---- the agent's turn -------------------------------------------------------------------------

    def test_untapped_card_is_tracked_and_the_agent_says_it_places_it_on_approval(self):
        response = self.ask()
        self.assertEqual(response, {'error': 'approval_required', 'instruction': mini.ORDER_PLACED_ON_APPROVAL})
        self.assertIn("I've sent your approval card to your approvals bot; tap Approve there and I'll place it.", response['instruction'])
        marker = json.loads(self.marker().read_text())
        self.assertEqual((marker['task'], marker['phase']), (TASK, 'awaiting'))
        self.assertEqual(self.marker().stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.confirms(), [])
        self.daemon.start.assert_not_called()

    def test_without_the_poller_the_older_instruction_stays_and_nothing_is_tracked(self):
        with patch.object(bridge, '_ensure_forkicks_pass', return_value=False):
            response = self.ask()
        self.assertEqual(response['instruction'], mini.ORDER_APPROVE_IN_BOT)
        self.assertFalse(self.marker().exists())

    def test_operator_poller_switch_off_means_no_poller_and_the_older_instruction(self):
        ap = types.ModuleType('hermes_plugins.av_events._approval')
        ap.POLLER_ENV = 'AV_APPROVAL_POLLER'
        ap.configured = lambda: True
        ap.process_env = lambda name: os.environ.get(name, '').strip()
        ap.register_pass, ap.ensure_poller = Mock(), Mock(return_value=True)
        with patch.dict(sys.modules, {'hermes_plugins.av_events._approval': ap}), patch.object(bridge, '_ensure_forkicks_pass', ENSURE):
            for off in ('0', 'false', 'No', ' off '):
                with self.subTest(off=off), patch.dict(os.environ, {'AV_APPROVAL_POLLER': off}):
                    self.assertFalse(bridge._ensure_forkicks_pass())
            ap.register_pass.assert_not_called(); ap.ensure_poller.assert_not_called()
            with patch.dict(os.environ, {'AV_APPROVAL_POLLER': '0'}):
                self.assertEqual(self.ask()['instruction'], mini.ORDER_APPROVE_IN_BOT)
            self.assertFalse(self.marker().exists())
            ap.ensure_poller.assert_not_called()
            # Switch on (or unset): the pass is registered on the poller and the poller is started.
            for path in self.home.joinpath('forkicks-drafts').glob('*'):
                path.unlink()
            with patch.dict(os.environ, {'AV_APPROVAL_POLLER': '1'}):
                self.assertEqual(self.ask()['instruction'], mini.ORDER_PLACED_ON_APPROVAL)
            ap.register_pass.assert_called_with(grant.PASS_NAME, bridge._forkicks_grant_pass)
            ap.ensure_poller.assert_called()
            ap.configured = lambda: False
            ap.ensure_poller.reset_mock()
            self.assertFalse(bridge._ensure_forkicks_pass())
            ap.ensure_poller.assert_not_called()

    # ---- granted -> placed once + the line ---------------------------------------------------------

    def test_granted_places_the_order_once_and_tells_only_the_owner_dm(self):
        self.ask()
        self.run_pass()  # not tapped yet
        self.assertEqual(self.confirms(), [])
        self.daemon.start.assert_not_called()
        self.daemon.state = 'granted'
        self.run_pass()
        # B2: the SAME start with the saved held bytes; never a propose (no new card).
        self.daemon.start.assert_called_once_with(TASK, KEY, fk.canonical(self.prepared['approvalPayload']))
        self.assertEqual(self.daemon.propose.call_count, 1)
        [confirm] = self.confirms()
        self.assertEqual(confirm.args[1], {'operation': 'forkicks.order.confirm', 'draftId': DRAFT, 'approval': {
            'taskId': TASK, 'payloadHash': self.prepared['payloadHash'], 'payload': self.prepared['approvalPayload']}})
        self.assertEqual(self.app.orders, 1)
        self.assertEqual(self.sent, [('42', PLACED)])  # the paired owner's own DM, product words, preview facts
        self.assertEqual(self.events, [{'outcome': 'placed', 'code': 'on_grant'}])
        self.assertFalse(self.marker().exists())
        self.assertEqual(json.loads(self.marker('.placed').read_text())['by'], 'pass')
        self.run_pass(); self.run_pass()
        self.assertEqual((len(self.confirms()), len(self.sent), len(self.events)), (1, 1, 1))
        # The agent's later retry answers the same receipt and calls nothing.
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('11')
        self.transport.reset_mock()
        self.assertEqual(self.call({'operation': 'forkicks.order.confirm', 'draftId': DRAFT})['data'], RECEIPT)
        self.transport.assert_not_called()
        self.assertEqual(self.daemon.propose.call_count, 1)

    def test_line_goes_to_the_paired_owner_even_when_the_saved_turn_names_another_chat(self):
        self.ask()
        path = self.marker('.json')
        record = json.loads(path.read_text()); record['session'] = 'telegram:77'; record['message'] = '77'
        path.write_text(fk.canonical(record))
        self.daemon.state = 'granted'
        self.run_pass()
        self.assertEqual([owner for owner, _ in self.sent], [self.config['ownerTelegramId']])

    # ---- the flat (card-shape) record: part A's payload, the order preview beside it ----------------

    def test_flat_card_record_is_tracked_granted_started_confirmed_and_told_once(self):
        # approval L17927 BLOCKER: under part A a card record's payload is {order, total, pickup, name} and the order
        # preview is saved BESIDE it (record['preview']). The pass must check it with that preview and read the quote
        # expiry and the line's facts from it, or it drops the marker as not_this_box and nothing is ever placed.
        response = self.ask(shape='flat')
        self.assertEqual(set(self.prepared['approvalPayload']), fk.CARD_KEYS)
        self.assertEqual(response, {'error': 'approval_required', 'instruction': mini.ORDER_PLACED_ON_APPROVAL})
        record = json.loads(self.marker('.json').read_text())
        self.assertTrue(fk.is_flat(record['payload']))
        self.assertEqual(record['preview'], self.prepared['preview'])
        self.assertEqual((json.loads(self.marker().read_text())['task']), TASK)  # tracked
        self.run_pass()  # not tapped yet: still tracked, nothing started
        self.assertTrue(self.marker().exists())
        self.daemon.start.assert_not_called()
        self.daemon.state = 'granted'
        self.run_pass()
        held = fk.canonical(self.prepared['approvalPayload'])
        self.daemon.start.assert_called_once_with(TASK, KEY, held)  # the app's card bytes, byte for byte
        self.assertEqual(self.daemon.propose.call_count, 1)
        self.assertEqual(self.daemon.propose.call_args.args[3], held)
        [confirm] = self.confirms()
        self.assertEqual(confirm.args[1], {'operation': 'forkicks.order.confirm', 'draftId': DRAFT, 'approval': {
            'taskId': TASK, 'payloadHash': self.prepared['payloadHash'], 'payload': self.prepared['approvalPayload']}})
        self.assertEqual(self.app.orders, 1)
        self.assertEqual(self.sent, [('42', PLACED)])  # exactly one placed line, with the preview's facts
        self.assertEqual(self.events, [{'outcome': 'placed', 'code': 'on_grant'}])
        self.assertFalse(self.marker().exists())
        self.assertEqual(json.loads(self.marker('.placed').read_text())['by'], 'pass')
        self.run_pass(); self.run_pass()
        self.assertEqual((len(self.confirms()), len(self.sent), len(self.events)), (1, 1, 1))
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('11')
        self.transport.reset_mock()
        self.assertEqual(self.call({'operation': 'forkicks.order.confirm', 'draftId': DRAFT})['data'], RECEIPT)
        self.transport.assert_not_called()

    def test_flat_card_record_with_an_expired_quote_is_told_expired_never_started(self):
        self.ask(expires='2020-01-01T00:00:00+05:30', shape='flat', confirm=False)
        self.daemon.state = 'granted'
        self.run_pass()
        self.daemon.wait.assert_called_once_with(TASK)  # ov#465 N1: read first (not spent: the expired line)
        self.daemon.start.assert_not_called()
        self.assertEqual(self.confirms(), [])
        self.assertEqual(self.sent, [('42', "Your For Kicks order wasn't placed: the approval or the price quote expired.")])
        self.assertEqual(self.events, [{'outcome': 'expired', 'code': 'quote_expired'}])

    def test_flat_card_record_whose_saved_preview_was_changed_is_ignored(self):
        self.ask(shape='flat')
        path = self.marker('.json')
        record = json.loads(path.read_text()); record['preview']['displayName'] = 'Mallory'
        os.chmod(path, 0o600); path.write_text(fk.canonical(record))
        self.daemon.state = 'granted'
        self.run_pass()
        self.daemon.wait.assert_not_called()
        self.assertEqual((self.confirms(), self.sent, self.events), ([], [], []))
        self.assertFalse(self.marker().exists())

    # ---- consent: only a human grant ---------------------------------------------------------------

    def test_denied_withdrawn_expired_and_void_send_one_line_and_place_nothing(self):
        cases = {'rejected': ('denied', 'the approval was declined'), 'revoked': ('denied', 'the approval was declined'),
                 'withdrawn': ('denied', 'the approval request was withdrawn'),
                 'expired': ('expired', 'the approval or the price quote expired'), 'void': ('expired', 'the approval or the price quote expired')}
        for state, (outcome, reason) in cases.items():
            with self.subTest(state=state):
                for path in self.home.joinpath('forkicks-drafts').glob('*'):
                    path.unlink()
                self.sent.clear(); self.events.clear(); self.daemon.state = 'requested'
                self.ask()
                self.daemon.state = state
                self.run_pass(); self.run_pass()
                self.daemon.start.assert_not_called()
                self.assertEqual(self.confirms(), [])
                self.assertEqual(self.sent, [('42', f"Your For Kicks order wasn't placed: {reason}.")])
                self.assertEqual([e['outcome'] for e in self.events], [outcome])
                self.assertFalse(self.marker().exists())

    def test_a_grant_read_needs_this_drafts_own_action_granted_and_a_grant_start(self):
        self.ask()
        for read in (granted(key=KEY + 'x'), granted(state='executed'), answer(0, ok=True, task=TASK, status='granted', actions=[]),
                     answer(0, ok=True, task=TASK, status='requested', actions=[{'action_key': KEY, 'state': 'granted'}])):
            with self.subTest(read=read.doc):
                self.daemon.wait.side_effect = lambda task, read=read: read
                self.run_pass()
                self.daemon.start.assert_not_called()
                self.assertEqual(self.confirms(), [])
        # A start the daemon authorized by policy (not a human grant) never reaches the app.
        self.daemon.wait.side_effect = self.daemon._wait
        self.daemon.state, self.daemon.authorization = 'granted', 'policy'
        self.run_pass()
        self.daemon.start.assert_called_once()
        self.assertEqual(self.confirms(), [])
        self.assertEqual(self.sent, [])

    # ---- one placer --------------------------------------------------------------------------------

    def test_agent_retry_during_the_pass_confirm_gets_the_lease_answer_and_exactly_one_order(self):
        self.ask()
        self.daemon.state = 'granted'
        retried = {}

        def agent_retry():
            self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('11')
            retried['answer'] = self.call({'operation': 'forkicks.order.confirm', 'draftId': DRAFT})

        self.app.during = agent_retry
        self.run_pass()
        self.assertEqual(retried['answer']['data']['error'], 'forkicks_confirm_in_progress')
        self.assertEqual(self.app.orders, 1)
        self.assertEqual(self.sent, [('42', PLACED)])
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('12')
        before = len(self.confirms())
        self.assertEqual(self.call({'operation': 'forkicks.order.confirm', 'draftId': DRAFT})['data'], RECEIPT)
        self.assertEqual(len(self.confirms()), before)
        self.assertEqual(self.app.orders, 1)

    def test_agent_that_placed_it_first_is_not_followed_by_a_second_order_or_line(self):
        self.ask()
        self.daemon.state = 'granted'
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('11')
        self.assertEqual(self.call({'operation': 'forkicks.order.confirm', 'draftId': DRAFT})['data'], RECEIPT)
        self.assertEqual(json.loads(self.marker('.placed').read_text())['by'], 'agent')
        confirms = len(self.confirms())
        self.run_pass()
        self.assertEqual(len(self.confirms()), confirms)
        self.assertEqual(self.app.orders, 1)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.events, [{'outcome': 'placed', 'code': 'agent_retry'}])
        self.assertFalse(self.marker().exists())

    def test_lost_confirm_answer_is_retried_with_the_same_draft_and_told_once(self):
        self.ask()
        self.daemon.state = 'granted'
        self.transport.side_effect = TimeoutError()
        self.run_pass()
        self.assertEqual(json.loads(self.marker().read_text())['phase'], 'attempted')
        self.assertEqual(self.sent, [])
        self.transport.side_effect = self.app
        self.run_pass()
        self.assertEqual([c.args[1]['draftId'] for c in self.confirms()], [DRAFT, DRAFT])
        self.daemon.start.assert_called_once()
        self.assertEqual(self.sent, [('42', PLACED)])

    def test_lease_held_by_another_confirm_waits_for_the_next_pass(self):
        self.ask()
        self.daemon.state = 'granted'
        self.app.leased = True
        self.run_pass()
        self.assertTrue(self.marker().exists())
        self.assertEqual((self.sent, self.events), ([], []))
        self.app.leased = False
        self.run_pass()
        self.assertEqual(self.sent, [('42', PLACED)])

    def test_definite_refusals_say_not_placed_once(self):
        for result, code in (({'error': 'pickup_only:coffee', 'status': 409, 'instruction': 'x'}, 'pickup_only'),
                             ({'error': 'forkicks_order_rejected'}, 'order_rejected'),
                             ({'error': 'connection_or_request_refused', 'status': 404}, 'refused_404')):
            with self.subTest(code=code):
                for path in self.home.joinpath('forkicks-drafts').glob('*'):
                    path.unlink()
                self.sent.clear(); self.events.clear(); self.daemon.state = 'requested'
                self.transport.side_effect = self.app
                self.ask()
                self.daemon.state = 'granted'
                self.transport.side_effect = lambda config, payload, result=result: result
                self.run_pass(); self.run_pass()
                self.assertEqual(self.sent, [('42', "Your For Kicks order wasn't placed: For Kicks couldn't take it.")])
                self.assertEqual(self.events, [{'outcome': 'failed', 'code': code}])

    # ---- only this box's drafts; never past the quote ---------------------------------------------

    def test_expired_quote_is_the_failure_line_never_a_start_or_requote(self):
        self.ask(expires='2020-01-01T00:00:00+05:30', confirm=False)
        self.daemon.state = 'granted'
        self.run_pass()
        self.daemon.wait.assert_called_once_with(TASK)  # ov#465 N1: read first (not spent: the expired line)
        self.daemon.start.assert_not_called()
        self.assertEqual(self.daemon.propose.call_count, 1)
        self.assertEqual(self.confirms(), [])
        self.assertEqual(self.sent, [('42', "Your For Kicks order wasn't placed: the approval or the price quote expired.")])
        self.assertEqual(self.events, [{'outcome': 'expired', 'code': 'quote_expired'}])

    def test_draft_not_saved_by_this_box_for_this_owner_is_ignored(self):
        self.ask()
        path = self.marker('.json')
        record = json.loads(path.read_text()); record['owner'] = '43'
        os.chmod(path, 0o600); path.write_text(fk.canonical(record))
        self.daemon.state = 'granted'
        self.run_pass()
        self.daemon.wait.assert_not_called()
        self.assertEqual((self.confirms(), self.sent, self.events), ([], [], []))
        self.assertFalse(self.marker().exists())
        # A marker with no saved preview at all: ignored too.
        grant.track(self.home, '11111111-1111-4111-8111-111111111111', TASK)
        self.run_pass()
        self.assertEqual((self.confirms(), self.sent, self.events), ([], [], []))

    # ---- bounded -----------------------------------------------------------------------------------

    def test_a_pass_reads_at_most_the_cap_and_closes_markers_past_the_ttl(self):
        context = bridge.bound_context()
        drafts = ['%08d-0000-4000-8000-000000000000' % i for i in range(grant.MAX_PER_PASS + 3)]
        for draft in drafts:
            result, _ = self.preview(draft=draft)
            fk.save_preview(self.home, result, context, self.config)
            grant.track(self.home, draft, TASK)
        self.run_pass()
        self.assertEqual(self.daemon.wait.call_count, grant.MAX_PER_PASS)
        self.daemon.wait.reset_mock()
        old = int(time.time()) - grant.TTL_S - 1
        for draft in drafts[:2]:
            path = self.home / 'forkicks-drafts' / (draft + '.await')
            path.write_text(json.dumps({'task': TASK, 'since': old, 'phase': 'awaiting', 'unverified': 0}))
        path = self.home / 'forkicks-drafts' / (drafts[2] + '.await')
        path.write_text(json.dumps({'task': TASK, 'since': old, 'phase': 'attempted', 'unverified': 0}))
        for draft in drafts[3:]:
            os.unlink(self.home / 'forkicks-drafts' / (draft + '.await'))
        self.run_pass()
        self.assertEqual(self.daemon.wait.call_count, 2)  # ov#465 N1: each awaiting marker's wait is read first
        self.assertEqual(sorted(e['code'] for e in self.events), ['ttl', 'ttl', 'uncertain_ttl'])
        # Each unanswered card is told once; the lost-confirm one is not told (its order may exist).
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(list(self.home.joinpath('forkicks-drafts').glob('*.await')), [])

    def test_one_shot_pass_outside_the_gateway_acts_on_nothing(self):
        self.ask()
        self.daemon.state = 'granted'
        bridge._forkicks_grant_pass(execute=False)
        self.daemon.wait.assert_not_called()
        self.assertEqual((self.confirms(), self.sent), ([], []))

    # ---- events: codes only ------------------------------------------------------------------------

    def test_events_carry_codes_only(self):
        self.ask()
        self.daemon.state = 'granted'
        self.run_pass()
        for event in self.events:
            self.assertEqual(set(event), {'outcome', 'code'})
            self.assertIn(event['outcome'], grant.OUTCOMES)
            self.assertRegex(event['code'], r'^[a-z0-9_]{1,40}$')
        text = json.dumps(self.events)
        for private in ('Priya', 'Café', DRAFT, TASK, '42', 'order-1'):
            self.assertNotIn(private, text)

    def test_lines_are_product_constants_and_never_ask_for_approval(self):
        def record(shape='legacy'):
            result = self.preview(shape=shape)[0]
            return {'payload': result['approvalPayload'], **({'preview': result['preview']} if shape == 'flat' else {})}

        self.assertEqual(grant.placed_line(record()), PLACED)
        self.assertEqual(grant.placed_line(record('flat')), PLACED)  # the preview BESIDE a flat payload
        delivery = record()
        delivery['payload']['preview']['fulfilment'] = {'type': 'delivery', 'locationId': 'cafe', 'deliveryAddress': 'House A'}
        self.assertEqual(grant.placed_line(delivery), grant.PLACED_LINE_PLAIN)
        hostile = record()
        for name in ('MEDIA:/etc/passwd', 'x MEDIA: /tmp/a.png'):
            hostile['payload']['preview']['quote']['location']['name'] = name
            self.assertNotIn('MEDIA:', grant.placed_line(hostile))
        hostile['payload']['preview']['quote']['location']['name'] = '\u202e'
        self.assertEqual(grant.placed_line(hostile), grant.PLACED_LINE_PLAIN)
        hostile['payload']['preview']['quote']['location']['name'] = '*Café* [x](https://e.vil)‮'
        self.assertNotIn('[', grant.placed_line(hostile)); self.assertNotIn('*', grant.placed_line(hostile))
        flat = record('flat')
        flat['preview']['quote']['location']['name'] = 'MEDIA:/etc/passwd'
        self.assertNotIn('MEDIA:', grant.placed_line(flat))
        for line in [grant.PLACED_LINE, grant.PLACED_LINE_PLAIN] + [grant.NOT_PLACED_LINE.format(reason=r) for r in grant.REASONS.values()]:
            self.assertNotIn('tap', line.lower())
            self.assertNotRegex(line.lower(), r'\bapprove\b')


if __name__ == '__main__':
    unittest.main()
