"""FK-CARD-AT-PREPARE (P0, CLAIMS L19913; lead L19916; approval L19920; lead L19923): the bridge raises the For Kicks
approval card right after a saved prepare, with no model turn in between. The tap is the human gate: the FK-ON-GRANT
pass places the order and sends one line. One card per draft; a same-turn confirm never places without the grant.
Offline: a fake daemon, a fake app, no Telegram, no network."""
import hashlib
import importlib.util
import json
from datetime import datetime
from pathlib import Path
import re
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
# The FK-ON-GRANT test module's fakes (Daemon, App), loaded by path once. Only the module object is bound here, so its
# test class is not collected a second time from this file.
on_grant = sys.modules.get('village_bridge_test_forkicks_grant')
if on_grant is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_forkicks_grant', Path(__file__).with_name('test_forkicks_grant.py'))
    on_grant = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = on_grant
    _spec.loader.exec_module(on_grant)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']
grant = sys.modules['village_bridge._forkicks_grant']

DRAFT, TASK, KEY, RECEIPT, PLACED = on_grant.DRAFT, on_grant.TASK, on_grant.KEY, on_grant.RECEIPT, on_grant.PLACED
answer = on_grant.answer
SAID = "I've sent your approval card to your approvals bot; tap Approve there and I'll place it. If no card arrives within a minute, tell me and I'll check."


class CardAtPrepareTest(unittest.TestCase):
    setUp_bridge = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call
    preview = on_grant.ForKicksOnGrantTest.preview
    marker = on_grant.ForKicksOnGrantTest.marker
    confirms = on_grant.ForKicksOnGrantTest.confirms

    def setUp(self):
        self.setUp_bridge()
        self.home = Path(self.tmp.name)
        (self.home / 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        for name in ('gate_verified', '_ensure_forkicks_pass'):
            p = patch.object(bridge, name, return_value=True if name == '_ensure_forkicks_pass' else None)
            p.start(); self.addCleanup(p.stop)
        self.daemon = on_grant.Daemon()
        self.modules = {}
        for module in (fk, grant):
            p = patch.object(module, 'approval_modules', return_value=self.daemon)
            self.modules[module] = p.start(); self.addCleanup(p.stop)
        self.sent = []
        p = patch.object(grant, '_telegram_dm', side_effect=lambda owner, text: self.sent.append((owner, text)) or True)
        p.start(); self.addCleanup(p.stop)
        self.events = []
        grant.set_emitter(self.events.append); self.addCleanup(grant.set_emitter, None)
        self.app = on_grant.App(self)
        self.transport.side_effect = self.app
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')

    def prepare(self, shape='legacy', expires='2099-01-01T00:00:00+05:30'):
        self.prepared, order = self.preview(expires=expires, shape=shape)
        self.order = order
        return self.call({'operation': 'forkicks.order.prepare', **order})

    def confirm(self):
        return self.call({'operation': 'forkicks.order.confirm', 'draftId': DRAFT})

    def run_pass(self):
        bridge._forkicks_grant_pass()

    def assert_nothing_placed(self):
        self.assertEqual(self.confirms(), [])
        self.assertEqual(self.app.orders, 0)
        self.assertFalse(self.marker('.placed').exists())

    # ---- prepare raises the card ------------------------------------------------------------------

    def test_prepare_raises_exactly_one_propose_with_nothing_between_and_the_preview_says_so(self):
        log = []

        def app(config, payload):
            out = self.app(config, payload)
            log.append(('transport', payload['operation'], time.perf_counter()))
            return out

        def spy(name, real):
            return lambda *a: log.append((name, a[1] if name == 'propose' else a[0], time.perf_counter())) or real(*a)

        self.daemon.propose.side_effect = spy('propose', self.daemon._propose)
        self.daemon.wait.side_effect = spy('wait', self.daemon._wait)
        self.transport.side_effect = app
        with patch.object(time, 'sleep', side_effect=AssertionError('no sleep between prepare and the card')):
            response = self.prepare()
        # The preview, plus the card's state and the agent's instruction.
        self.assertEqual(response['data'], self.prepared)
        self.assertEqual((response['approval'], response['instruction']), ('requested', mini.ORDER_PLACED_ON_APPROVAL))
        self.assertNotIn('error', response)
        # (5) The work between prepare's answer and the card: ONE propose, then one `wait --timeout 0` read. No other
        # daemon or app call, no sleep, no second propose, no start, no confirm.
        self.assertEqual([entry[:2] for entry in log], [('transport', 'forkicks.order.prepare'), ('propose', KEY), ('wait', TASK)])
        gap = log[1][2] - log[0][2]
        self.assertLess(gap, 0.5)  # offline: only the saved-record read and the summary (measured in the report)
        cls, key, summary, held = self.daemon.propose.call_args.args
        self.assertEqual((cls, key), ('marketplace.app.action', KEY))  # no new class; the per-draftId key
        self.assertEqual(held, fk.canonical(self.prepared['approvalPayload']))
        self.assertEqual(summary, fk.approval_summary(self.prepared['approvalPayload']))
        self.daemon.start.assert_not_called()
        self.assert_nothing_placed()
        # Handed to the FK-ON-GRANT pass, and the card's task remembered for this draft.
        self.assertEqual(json.loads(self.marker().read_text())['task'], TASK)
        self.assertEqual(json.loads(self.marker('.card').read_text()), {'task': TASK})

    def test_tap_after_prepare_places_the_order_once_with_one_line_and_a_later_confirm_proposes_nothing(self):
        self.prepare()
        self.run_pass()  # not tapped yet
        self.assert_nothing_placed()
        self.daemon.state = 'granted'  # the resident taps Approve
        self.run_pass()
        self.daemon.start.assert_called_once_with(TASK, KEY, fk.canonical(self.prepared['approvalPayload']))
        self.assertEqual(len(self.confirms()), 1)
        self.assertEqual(self.app.orders, 1)
        self.assertEqual(self.sent, [('42', PLACED)])
        self.assertTrue(self.sent[0][1].startswith('Approved: your For Kicks order is placed'))
        self.run_pass(); self.run_pass()
        self.assertEqual((len(self.confirms()), len(self.sent)), (1, 1))
        # A later confirm (same turn or a later one): the recorded receipt, no daemon or app call, and the agent is
        # told the owner already has the line (no second announcement).
        for message in ('9', '11'):
            self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set(message)
            self.transport.reset_mock(); self.daemon.wait.reset_mock()
            response = self.confirm()
            self.assertEqual(response['data'], RECEIPT)
            self.assertEqual(response['instruction'], mini.ORDER_ALREADY_TOLD)
            self.transport.assert_not_called(); self.daemon.wait.assert_not_called()
        self.assertEqual(self.daemon.propose.call_count, 1)
        self.daemon.start.assert_called_once()
        self.assertEqual(self.app.orders, 1)
        self.assertEqual(len(self.sent), 1)

    def test_same_turn_confirm_without_the_grant_never_places_and_reuses_the_one_card(self):
        self.prepare()
        # A daemon whose start would say `grant` to anything: only the box's own checks stand between the agent and
        # the café (approval L19920 (1): a granted wait first, then a start whose authorization is `grant`).
        self.daemon.start = Mock(return_value=answer(0, ok=True, authorization='grant'))
        response = self.confirm()  # the SAME turn as the prepare (message 9)
        self.assertEqual(response, {'error': 'approval_required', 'instruction': mini.ORDER_PLACED_ON_APPROVAL})
        self.daemon.start.assert_not_called()
        self.assert_nothing_placed()
        # (2) A looping confirm cannot flood the approvals bot: one propose for the draft, ever; each loop only reads.
        for _ in range(25):
            self.assertEqual(self.confirm()['error'], 'approval_required')
        self.assertEqual(self.daemon.propose.call_count, 1)
        self.assertEqual({c.args[0] for c in self.daemon.wait.call_args_list}, {TASK})
        self.assertEqual(self.daemon.wait.call_count, 1 + 1 + 25)
        self.daemon.start.assert_not_called()
        self.assert_nothing_placed()
        # A rejected, expired or still-pending card read at confirm is never a start either.
        for state in ('rejected', 'expired', 'void', 'withdrawn'):
            self.daemon.state = state
            self.assertNotIn('data', self.confirm())
        self.daemon.start.assert_not_called()
        self.assert_nothing_placed()
        self.assertEqual(self.daemon.propose.call_count, 1)

    def test_a_granted_read_whose_start_is_not_a_human_grant_never_places(self):
        self.prepare()
        self.daemon.state, self.daemon.authorization = 'granted', 'policy'
        response = self.confirm()
        self.assertEqual(response['error'], 'approval_not_started')
        self.assertEqual(response['instruction'], mini.ORDER_APPROVAL_REFUSED)
        self.assert_nothing_placed()

    def test_same_turn_confirm_after_the_tap_places_once_and_the_pass_adds_no_order_or_line(self):
        self.prepare()
        self.daemon.state = 'granted'
        response = self.confirm()  # same turn: the human grant is the authority
        self.assertEqual(response['data'], RECEIPT)
        self.assertNotIn('instruction', response)  # the agent placed it, so the agent tells them (the pass will not)
        self.run_pass(); self.run_pass()
        self.assertEqual((len(self.confirms()), self.app.orders), (1, 1))
        self.assertEqual(self.sent, [])
        self.assertEqual(self.events, [{'outcome': 'placed', 'code': 'agent_retry'}])
        self.assertEqual(self.daemon.propose.call_count, 1)

    def test_autonomous_or_supervised_decisions_never_raise_a_card_or_place(self):
        # approval L19920 (1): authorize_order accepts only `requested` (a purchase always needs a human).
        for decision in ('autonomous', 'supervised', None):
            with self.subTest(decision=decision):
                for path in self.home.joinpath('forkicks-drafts').glob('*'):
                    path.unlink()
                self.daemon.propose = Mock(side_effect=lambda cls, key, summary, payload, decision=decision: answer(
                    0, ok=True, task=TASK, decision=decision, payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
                response = self.prepare()
                self.assertEqual(response['data'], self.prepared)
                self.assertEqual((response['approval'], response['error']), ('refused', 'approval_refused'))
                self.assertEqual(response['instruction'], mini.ORDER_CARD_NOT_RAISED)
                self.assertFalse(self.marker('.card').exists()); self.assertFalse(self.marker().exists())
                confirmed = self.confirm()
                self.assertEqual((confirmed['error'], confirmed['instruction']), ('approval_refused', mini.ORDER_APPROVAL_REFUSED))
                self.daemon.start.assert_not_called()
                self.assert_nothing_placed()

    # ---- the card could not be raised: the preview, and an honest instruction --------------------

    def test_every_refusal_at_prepare_returns_the_preview_and_says_nothing_was_ordered(self):
        def refuse_with(**doc):
            return lambda cls, key, summary, payload: answer(0, **{'ok': True, 'task': TASK, 'decision': 'requested',
                                                                    'payload_hash': hashlib.sha256(payload.encode()).hexdigest(), **doc})
        cases = {
            'approval_modules unavailable': ('approval_unavailable', lambda: self.modules[fk].configure_mock(side_effect=ValueError('approval_unavailable'))),
            'propose raises': ('approval_unavailable', lambda: setattr(self.daemon.propose, 'side_effect', RuntimeError('timeout'))),
            'propose not ok': ('approval_refused', lambda: setattr(self.daemon.propose, 'side_effect', lambda *a: answer(1, ok=False, error={'code': 'x'}))),
            'hash mismatch': ('approval_refused', lambda: setattr(self.daemon.propose, 'side_effect', refuse_with(payload_hash='0' * 64))),
            'bad task id': ('approval_refused', lambda: setattr(self.daemon.propose, 'side_effect', refuse_with(task='propose:../x'))),
        }
        for label, (code, arrange) in cases.items():
            with self.subTest(label):
                for path in self.home.joinpath('forkicks-drafts').glob('*'):
                    path.unlink()
                self.daemon = on_grant.Daemon()
                for module, mock in self.modules.items():
                    mock.configure_mock(side_effect=None, return_value=self.daemon)
                arrange()
                response = self.prepare()
                self.assertEqual(response['data'], self.prepared)
                self.assertEqual(response['error'], code)
                self.assertEqual(response['approval'], 'unavailable' if code == 'approval_unavailable' else 'refused')
                self.assertEqual(response['instruction'], mini.ORDER_CARD_NOT_RAISED)
                self.assertIn('could not be raised, so nothing was ordered', response['instruction'])
                self.assertIn("I couldn't send the approval card, so I haven't ordered anything.", response['instruction'])
                self.daemon.start.assert_not_called()
                self.assert_nothing_placed()
        # The propose went out but the read after it failed: the card IS out, so the words say so (never "could not
        # be raised") and the pass is handed its task.
        for path in self.home.joinpath('forkicks-drafts').glob('*'):
            path.unlink()
        self.daemon = on_grant.Daemon()
        for mock in self.modules.values():
            mock.configure_mock(side_effect=None, return_value=self.daemon)
        self.daemon.wait.side_effect = RuntimeError('timeout')
        response = self.prepare()
        self.assertEqual((response['data'], response['approval'], response['instruction']), (self.prepared, 'requested', mini.ORDER_PLACED_ON_APPROVAL))
        self.assertNotIn('error', response)
        self.assertEqual(json.loads(self.marker().read_text())['task'], TASK)
        self.daemon.wait.side_effect = self.daemon._wait
        self.daemon.state = 'granted'
        self.run_pass()
        self.assertEqual((self.app.orders, self.sent), (1, [('42', PLACED)]))
        self.assertEqual(self.daemon.propose.call_count, 1)
        # A card the box refuses to draw (over the Telegram budget): the same answer, and no daemon call at all.
        for path in self.home.joinpath('forkicks-drafts').glob('*'):
            path.unlink()
        self.daemon = on_grant.Daemon()
        for mock in self.modules.values():
            mock.configure_mock(side_effect=None, return_value=self.daemon)
        self.prepared, order = self.preview()
        self.prepared['approvalPayload']['preview']['quote']['lines'][0]['options'] = ['<' * 800]
        self.prepared['payloadHash'] = hashlib.sha256(fk.canonical(self.prepared['approvalPayload']).encode()).hexdigest()
        response = self.call({'operation': 'forkicks.order.prepare', **order})
        self.assertEqual((response['data'], response['error']), (self.prepared, 'approval_card_too_long'))
        self.assertEqual(response['instruction'], mini.ORDER_CARD_NOT_RAISED)
        self.daemon.propose.assert_not_called()

    def test_confirm_refusals_carry_an_honest_instruction(self):
        self.prepare()
        self.modules[fk].configure_mock(side_effect=ValueError('approval_unavailable'))
        response = self.confirm()
        self.assertEqual(response, {'error': 'approval_unavailable', 'instruction': mini.ORDER_APPROVAL_UNAVAILABLE})
        self.assertIn('nothing was ordered', response['instruction'])
        self.modules[fk].configure_mock(side_effect=None, return_value=self.daemon)
        # A box with no card yet (the prepare-time propose was refused) whose confirm is refused too.
        (self.home / 'forkicks-drafts' / (DRAFT + '.card')).unlink()
        self.daemon.propose = Mock(return_value=answer(0, ok=True, task=TASK, decision='autonomous', payload_hash=self.prepared['payloadHash']))
        response = self.confirm()
        self.assertEqual(response, {'error': 'approval_refused', 'instruction': mini.ORDER_APPROVAL_REFUSED})
        self.assertIn('nothing was ordered', response['instruction'])
        self.assert_nothing_placed()

    # ---- the flat-card fallback: a card for the FINAL saved draft only ----------------------------

    def test_fallback_prepare_proposes_only_for_the_final_saved_draft(self):
        flat, order = self.preview(shape='flat')
        flat['approvalPayload'] = {**flat['approvalPayload'], 'order': '1 × Free latte'}  # a card this box refuses
        flat['payloadHash'] = hashlib.sha256(fk.canonical(flat['approvalPayload']).encode()).hexdigest()
        legacy_draft = '660e8400-e29b-41d4-a716-446655440000'
        legacy, _ = self.preview(draft=legacy_draft)
        self.transport.side_effect = [flat, legacy]
        with self.assertLogs('village_bridge', 'WARNING'):
            response = self.call({'operation': 'forkicks.order.prepare', **order})
        self.assertEqual(response['data'], legacy)
        self.assertEqual(response['approval'], 'requested')
        self.assertEqual([c.kwargs for c in self.transport.call_args_list], [{}, {'flat_card': False}])
        self.daemon.propose.assert_called_once()
        cls, key, _, held = self.daemon.propose.call_args.args
        self.assertEqual((cls, key, held), ('marketplace.app.action', 'marketplace.app.action:forkicks.order.confirm:' + legacy_draft,
                                            fk.canonical(legacy['approvalPayload'])))
        folder = self.home / 'forkicks-drafts'
        self.assertEqual(sorted(p.name for p in folder.iterdir()), sorted(['.latest', '.lock'] + [legacy_draft + s for s in ('.json', '.card', '.await')]))

    # ---- one card per draft, the owner's own DM -----------------------------------------------------

    def test_a_replayed_prepare_of_the_same_draft_raises_no_second_card(self):
        self.prepare()
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')
        response = self.prepare()
        self.assertEqual(response['approval'], 'requested')
        self.assertEqual(self.daemon.propose.call_count, 1)

    def test_prepare_and_confirm_run_only_in_the_paired_owners_own_dm(self):
        # approval L19920 (1): bound_context stays. Another chat, a group, or a delegated child: no call, no card.
        # Another chat, a group, a different user, or another resident's own DM (CHAT_ID == USER_ID != the paired owner).
        for change in ({'HERMES_SESSION_CHAT_ID': '43'}, {'HERMES_SESSION_CHAT_TYPE': 'group'}, {'HERMES_SESSION_USER_ID': '43'},
                       {'HERMES_SESSION_CHAT_ID': '43', 'HERMES_SESSION_USER_ID': '43'}):
            with self.subTest(change=change):
                original = {name: self.sc._VAR_MAP[name].get() for name in change}
                for name, value in change.items():
                    self.sc._VAR_MAP[name].set(value)
                try:
                    self.assertEqual(self.prepare(), {'error': 'private_owner_chat_required'})
                    self.assertEqual(self.confirm(), {'error': 'private_owner_chat_required'})
                finally:
                    for name, value in original.items():
                        self.sc._VAR_MAP[name].set(value)
        self.transport.assert_not_called()
        self.daemon.propose.assert_not_called()

    # ---- card latency: one codes-only line + event per draft (lead L20022) ---------------------------

    LINE = re.compile(r'^INFO:village_bridge:village_bridge forkicks card_requested task_hash=([0-9a-f]{16}) '
                      r'at=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$')

    def card_lines(self, logs):
        return [line for line in logs.output if 'card_requested' in line]

    def test_card_requested_fires_once_per_draft_with_the_hash_and_time_only(self):
        cards = []
        grant.set_card_emitter(cards.append); self.addCleanup(grant.set_card_emitter, None)
        before = time.time()
        with self.assertLogs('village_bridge', 'INFO') as logs:
            self.prepare()
            for _ in range(25):
                self.confirm()  # same turn, a loop
            self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')
            self.prepare()  # a replayed prepare of the same draft
            self.confirm()
        after = time.time()
        [line] = self.card_lines(logs)
        found = self.LINE.match(line)
        self.assertIsNotNone(found, line)
        expected = hashlib.sha256(TASK.encode()).hexdigest()[:16]
        self.assertEqual(found.group(1), expected)
        self.assertEqual(cards, [{'task_hash': expected, 'at': found.group(2)}])
        stamp = datetime.fromisoformat(found.group(2).replace('Z', '+00:00')).timestamp()
        self.assertTrue(before - 0.001 <= stamp <= after + 0.001)
        for private in (DRAFT, TASK, TASK.split(':')[1], 'Priya', 'Caf', 'Coffee'):  # no ids, no text
            self.assertNotIn(private, line + json.dumps(cards))
        self.assertEqual(set(cards[0]), {'task_hash', 'at'})
        self.assertEqual(self.daemon.propose.call_count, 1)

    def test_card_requested_never_fires_without_a_requested_propose_and_fires_at_a_first_confirm(self):
        cards = []
        grant.set_card_emitter(cards.append); self.addCleanup(grant.set_card_emitter, None)
        real = self.daemon.propose.side_effect
        self.daemon.propose.side_effect = lambda cls, key, summary, payload: answer(
            0, ok=True, task=TASK, decision='autonomous', payload_hash=hashlib.sha256(payload.encode()).hexdigest())
        with self.assertLogs('village_bridge', 'INFO') as logs:
            self.prepare(); self.confirm()
            self.modules[fk].configure_mock(side_effect=ValueError('approval_unavailable'))
            self.confirm()
            grant.LOG.info('village_bridge test sentinel')  # assertLogs needs one line
        self.assertEqual((self.card_lines(logs), cards), ([], []))
        # The prepare-time card could not be raised; the first `requested` propose is a later confirm's: it fires there, once.
        self.modules[fk].configure_mock(side_effect=None, return_value=self.daemon)
        self.daemon.propose.side_effect = real
        with self.assertLogs('village_bridge', 'INFO') as logs:
            self.confirm(); self.confirm(); self.confirm()
        self.assertEqual(len(self.card_lines(logs)), 1)
        self.assertEqual(len(cards), 1)

    def test_register_publishes_card_requested_on_the_plugin_bus(self):
        ctx = Mock()
        with patch.object(bridge, '_REGISTERED', False), patch.object(bridge, '_gateway_argv', return_value=False):
            bridge.register(ctx)
        self.addCleanup(grant.set_card_emitter, None); self.addCleanup(grant.set_emitter, None)
        payload = grant.card_requested(TASK, now=0)
        self.assertEqual(payload, {'task_hash': hashlib.sha256(TASK.encode()).hexdigest()[:16], 'at': '1970-01-01T00:00:00.000Z'})
        ctx.emit.assert_called_once_with('forkicks.card_requested', payload)

    # ---- product words (lead L19923: no delivery claim) --------------------------------------------

    def test_the_words_never_claim_the_card_arrived(self):
        text = mini.ORDER_PLACED_ON_APPROVAL
        self.assertIn('"' + SAID + '"', text)
        self.assertIn('delivery is not confirmed', text)
        for claim in ('is in the owner', 'arrived', 'the card that just', "I'll place it as soon as you approve"):
            self.assertNotIn(claim, text.replace('If no card arrives', ''))
        for refusal in (mini.ORDER_CARD_NOT_RAISED, mini.ORDER_APPROVAL_REFUSED, mini.ORDER_APPROVAL_UNAVAILABLE):
            self.assertIn('nothing was ordered', refusal)
            self.assertIn('never say', refusal.lower())
        self.assertTrue(grant.PLACED_LINE.startswith('Approved: your For Kicks order is placed'))
        self.assertTrue(grant.PLACED_LINE_PLAIN.startswith('Approved: your For Kicks order is placed'))
        skill = Path(__file__).parents[3].joinpath('skills', 'forkicks', 'SKILL.md').read_text(encoding='utf-8')
        flat = ' '.join(skill.split())
        self.assertIn('“' + SAID + '”', flat)
        self.assertIn('Do not ask for a “yes” in chat and do not wait for one: the card tap is the approval.', flat)
        self.assertNotIn("End the turn and wait for the resident's approval", flat)
        self.assertNotIn('Ask the resident to approve this exact order.', flat)


if __name__ == '__main__':
    unittest.main()
