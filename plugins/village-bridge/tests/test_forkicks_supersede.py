"""Review-a RA41 folds for ov#459 (lead L20080): S1 one live order per owner, S2 a closed card says "nothing was
ordered", S3 the spent-grant adoption branch pinned (review-a's probes, copied from
lanes-review-a/ra41-probes/test_ra41_probes.py), N5 the For Kicks fast poll. Offline: a fake multi-task daemon
(core's key/bytes binding), a fake app, no network, no Telegram."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, call, patch

fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
on_grant = sys.modules.get('village_bridge_test_forkicks_grant')
if on_grant is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_forkicks_grant', Path(__file__).with_name('test_forkicks_grant.py'))
    on_grant = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = on_grant
    _spec.loader.exec_module(on_grant)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']
grant = sys.modules['village_bridge._forkicks_grant']
answer = on_grant.answer

D1 = '550e8400-e29b-41d4-a716-446655440001'
D2 = '550e8400-e29b-41d4-a716-446655440002'
D3 = '550e8400-e29b-41d4-a716-446655440003'
PAST = '2020-01-01T00:00:00+05:30'
PREFIX = 'marketplace.app.action:forkicks.order.confirm:'
PLACED_PREFIX = 'Approved: your For Kicks order is placed'


class MultiDaemon:
    """approval.md as the box sees it, one task per key, core binding the start to the task's own key + bytes."""

    def __init__(self):
        self.tasks = {}  # task -> {key, hash, state}
        self.propose = Mock(side_effect=self._propose)
        self.wait = Mock(side_effect=self._wait)
        self.start = Mock(side_effect=self._start)
        self.withdraw = Mock(side_effect=self._withdraw)
        self.raise_after_record = False

    def task_of(self, key):
        return 'propose:' + hashlib.md5(key.encode()).hexdigest()

    def _propose(self, cls, key, summary, payload):
        task = self.task_of(key)
        h = hashlib.sha256(payload.encode()).hexdigest()
        t = self.tasks.setdefault(task, {'key': key, 'hash': h, 'state': 'requested'})
        if self.raise_after_record:
            raise RuntimeError('timeout')  # the daemon recorded (and sent) the card; the box lost the answer
        return answer(0, ok=True, task=task, decision='requested', payload_hash=t['hash'],
                      state='executed' if t['state'] == 'started' else None)

    def _wait(self, task):
        t = self.tasks.get(task)
        if t is None:
            return answer(1, ok=True, task=task, status='not-registered')
        s = t['state']
        if s == 'requested':
            return answer(6, ok=False, task=task, status='requested')
        if s == 'granted':
            return answer(0, ok=True, task=task, status='granted', actions=[{'action_key': t['key'], 'state': 'granted'}])
        if s == 'started':
            return answer(0, ok=True, task=task, status='nothing-to-wait-for', actions=[{'action_key': t['key'], 'state': 'granted'}])
        code = {'rejected': 1, 'withdrawn': 1, 'expired': 3, 'void': 7}[s]
        return answer(code, ok=True, task=task, status=s, actions=[{'action_key': t['key'], 'state': s}])

    def _start(self, task, key, held):
        t = self.tasks.get(task)
        if t is None or t['state'] != 'granted' or t['key'] != key or hashlib.sha256(held.encode()).hexdigest() != t['hash']:
            return answer(1, ok=False, error={'code': 'not-granted'})
        t['state'] = 'started'
        return answer(0, ok=True, task=task, action_key=key, authorization='grant')

    def _withdraw(self, task, reason, key=None):
        # Core 0.4.7 commandWithdraw: by action key (no --action: usage, exit 2), a closed reason, a pending request only.
        if key is None or reason not in ('timeout', 'cancelled', 'superseded'):
            return answer(2, ok=False, error={'code': 'usage'})
        t = self.tasks.get(self.task_of(key))
        if t is None:
            return answer(1, ok=False, error={'code': 'not-requested'})
        if t['state'] != 'requested':
            return answer(1, ok=False, error={'code': 'already-decided'})  # granted, spent or closed: untouched
        t['state'] = 'withdrawn'
        return answer(0, ok=True, task=task, action_key=key, state='withdrawn', reason=reason)

    def tap(self, draft, state='granted'):
        self.tasks[self.task_of(PREFIX + draft)]['state'] = state


class MultiApp:
    def __init__(self, test):
        self.test, self.orders, self.prepares = test, {}, []

    def __call__(self, config, payload, **kw):
        if payload['operation'] == 'forkicks.order.prepare':
            return self.test.next_prepare
        draft = payload['draftId']
        self.orders[draft] = 1  # merchant-idempotent per draft
        return {'orderId': 'order-' + draft[-4:], 'number': '#0' + draft[-2:], 'status': 'queued'}


class MultiApp:
    def __init__(self, test):
        self.test, self.orders = test, {}

    def __call__(self, config, payload, **kw):
        if payload['operation'] == 'forkicks.order.prepare':
            return self.test.next_prepare
        draft = payload['draftId']
        self.orders[draft] = self.orders.get(draft, 0) + 1
        return {'orderId': 'order-' + draft[-4:], 'number': '#0' + draft[-2:], 'status': 'queued'}


class SupersedeTest(unittest.TestCase):
    setUp_bridge = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call
    preview = on_grant.ForKicksOnGrantTest.preview

    def setUp(self):
        self.setUp_bridge()
        self.home = Path(self.tmp.name)
        (self.home / 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        for name, value in (('_ensure_forkicks_pass', True), ('gate_verified', None)):
            p = patch.object(bridge, name, return_value=value); p.start(); self.addCleanup(p.stop)
        self.daemon = MultiDaemon()
        for module in (fk, grant):
            p = patch.object(module, 'approval_modules', return_value=self.daemon); p.start(); self.addCleanup(p.stop)
        self.sent = []
        p = patch.object(grant, '_telegram_dm', side_effect=lambda owner, text: self.sent.append((owner, text)) or True)
        p.start(); self.addCleanup(p.stop)
        self.app = MultiApp(self)
        self.transport.side_effect = self.app
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')

    def prepare(self, draft, qty=2, expires='2099-01-01T00:00:00+05:30'):
        self.next_prepare, order = self.preview(draft=draft, expires=expires)
        if qty != 2:
            pv = self.next_prepare['approvalPayload']['preview']
            pv['items'][0]['qty'] = qty
            pv['quote']['lines'][0].update(qty=qty, lineInr=190 * qty)
            pv['quote']['totalInr'] = 190 * qty
            self.next_prepare['payloadHash'] = hashlib.sha256(fk.canonical(self.next_prepare['approvalPayload']).encode()).hexdigest()
        return self.call({'operation': 'forkicks.order.prepare', **order})

    def confirm(self, draft):
        return self.call({'operation': 'forkicks.order.confirm', 'draftId': draft})

    def run_pass(self):
        bridge._forkicks_grant_pass()

    def placed_lines(self):
        return [text for _, text in self.sent if text.startswith(PLACED_PREFIX)]

    # ---- S1: one live order per owner ----------------------------------------------------------------

    def test_changed_order_two_taps_place_exactly_one_order_the_newest(self):
        self.assertEqual(self.prepare(D1)['approval'], 'requested')
        self.assertEqual(self.prepare(D2, qty=3)['approval'], 'requested')
        # At D2's prepare (after D2's card went out), D1's waiting card was withdrawn.
        self.daemon.withdraw.assert_called_once_with(self.daemon.task_of(PREFIX + D1), 'superseded', PREFIX + D1)
        self.assertEqual(self.daemon.tasks[self.daemon.task_of(PREFIX + D1)]['state'], 'withdrawn')  # core took it
        self.assertEqual(self.daemon.propose.call_args_list[-1].args[1], PREFIX + D2)  # D2's propose came first
        # The resident taps BOTH cards (core refusing nothing here: the box's own check must hold).
        self.daemon.tap(D1); self.daemon.tap(D2)
        self.run_pass(); self.run_pass()
        self.assertEqual(self.app.orders, {D2: 1})  # exactly one order, the newest
        self.assertEqual(len(self.placed_lines()), 1)
        self.assertEqual([t for _, t in self.sent if not t.startswith(PLACED_PREFIX)], [grant.SUPERSEDED_LINE])
        self.assertTrue(grant.SUPERSEDED_LINE.startswith('Nothing was ordered'))
        self.assertEqual({owner for owner, _ in self.sent}, {'42'})
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())

    def test_the_pass_refuses_an_older_draft_even_when_the_withdraw_never_reached_the_daemon(self):
        self.prepare(D1)
        self.daemon.withdraw.side_effect = RuntimeError('timeout')
        self.prepare(D2, qty=3)
        self.daemon.tap(D1)  # the old card was never withdrawn, and the resident taps it
        self.run_pass()
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})
        self.assertEqual(self.sent, [('42', grant.SUPERSEDED_LINE)])
        self.daemon.tap(D2)
        self.run_pass()
        self.assertEqual(self.app.orders, {D2: 1})

    def test_a_started_older_draft_is_not_abandoned(self):
        # Belt and braces applies only before a start: a draft whose grant was already started keeps its confirm.
        self.prepare(D1)
        self.daemon.tap(D1)
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        doc = json.loads(marker.read_text()); doc['phase'] = 'started'; marker.write_text(json.dumps(doc))
        self.daemon.tasks[self.daemon.task_of(PREFIX + D1)]['state'] = 'started'
        grant.set_latest(self.home, D2)
        self.run_pass()
        self.assertEqual(self.app.orders, {D1: 1})

    # ---- security review of S1: fail closed, last check before money moves, one lock -------------------

    def test_a_corrupt_latest_record_places_nothing(self):
        self.prepare(D1)
        for garbage in ('not json', '{"draftId": "../x"}', '[]'):
            with self.subTest(garbage=garbage):
                (self.home / 'forkicks-drafts' / '.latest').write_text(garbage)
                self.daemon.tap(D1)
                self.run_pass(); self.run_pass()
                self.daemon.start.assert_not_called()
                self.assertEqual(self.app.orders, {})
        self.assertEqual(self.sent, [('42', grant.LATEST_UNREADABLE_LINE)])  # one honest line for the draft
        self.assertTrue(grant.LATEST_UNREADABLE_LINE.startswith('Nothing was ordered'))

    def test_a_prepare_landing_between_the_check_and_the_start_wins(self):
        self.prepare(D1)
        self.daemon.tap(D1)
        real_wait = self.daemon.wait.side_effect

        def wait(task):  # D2's prepare lands after the pass's first newest check, before its start
            grant.set_latest(self.home, D2)
            return real_wait(task)

        self.daemon.wait.side_effect = wait
        self.run_pass()
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})
        self.assertEqual(self.sent, [('42', grant.SUPERSEDED_LINE)])

    def test_a_prepare_landing_between_the_start_and_the_confirm_wins(self):
        self.prepare(D1)
        self.daemon.tap(D1)
        real_guarded = grant.guarded_start

        def guarded(home, draft_id, start):
            out = real_guarded(home, draft_id, start)  # the start ran under the lock
            grant.set_latest(self.home, D2)  # D2's prepare takes the lock right after it, before the confirm
            return out

        with patch.object(grant, 'guarded_start', side_effect=guarded):
            self.run_pass()
        self.daemon.start.assert_called_once()
        self.assertEqual(self.app.orders, {})  # the spent grant places nothing
        self.assertEqual(self.sent, [('42', grant.SUPERSEDED_LINE)])

    def test_the_agents_confirm_of_an_older_draft_places_nothing(self):
        self.prepare(D1)
        self.daemon.withdraw.side_effect = RuntimeError('timeout')  # D1's card was never withdrawn
        self.prepare(D2, qty=3)
        self.daemon.tap(D1)  # the owner taps the old card
        response = self.confirm(D1)
        self.assertEqual(response, {'error': 'approval_card_closed', 'instruction': mini.ORDER_SUPERSEDED})
        self.assertIn('"Nothing was ordered from your earlier preview."', response['instruction'])
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})
        # Fail closed for the agent too: a corrupt record refuses the start of any draft.
        (self.home / 'forkicks-drafts' / '.latest').write_text('{')
        self.daemon.tap(D2)
        self.assertEqual(self.confirm(D2), {'error': 'approval_card_closed', 'instruction': mini.ORDER_NEWEST_UNREADABLE})
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})
        # The newest draft with a readable record places once.
        grant.set_latest(self.home, D2)
        self.assertIn('data', self.confirm(D2))
        self.assertEqual(self.app.orders, {D2: 1})

    def test_a_draft_refused_after_its_start_is_never_placed_by_the_agents_adoption(self):
        # Security review of 5a984408: the pass starts D1, D2 is prepared, the pass refuses D1 before its confirm
        # (tombstone); the agent's later confirm of D1 reads the spent grant (nothing-to-wait-for) and must not adopt it.
        self.prepare(D1)
        self.daemon.tap(D1)
        real_guarded = grant.guarded_start

        def guarded(home, draft_id, start):
            out = real_guarded(home, draft_id, start)
            grant.set_latest(self.home, D2)
            return out

        with patch.object(grant, 'guarded_start', side_effect=guarded):
            self.run_pass()
        self.daemon.start.assert_called_once()
        self.assertTrue((self.home / 'forkicks-drafts' / (D1 + '.refused')).exists())
        self.assertEqual(json.loads((self.home / 'forkicks-drafts' / (D1 + '.refused')).read_text()), {'code': 'superseded'})
        for _ in range(3):
            response = self.confirm(D1)
            self.assertEqual(response, {'error': 'approval_card_closed', 'instruction': mini.ORDER_SUPERSEDED})
        self.assertEqual(self.app.orders, {})
        self.assertEqual(self.sent, [('42', grant.SUPERSEDED_LINE)])
        # A corrupt tombstone fails closed.
        (self.home / 'forkicks-drafts' / (D1 + '.refused')).write_text('{not json')
        self.assertEqual(self.confirm(D1)['error'], 'approval_card_closed')
        self.assertTrue(grant.tombstoned(self.home, D1))
        self.assertEqual(self.app.orders, {})

    def test_an_unwritable_tombstone_fails_closed_and_the_next_pass_retries_it(self):
        # Security review of 9e201d83: a refusal whose tombstone cannot be written sends no line and leaves the
        # marker at awaiting, so the pass never confirms the draft and the next pass refuses it for good.
        self.prepare(D1)
        self.daemon.tap(D1)
        real_guarded = grant.guarded_start

        def guarded(home, draft_id, start):
            out = real_guarded(home, draft_id, start)
            grant.set_latest(self.home, D2)
            return out

        with patch.object(grant, 'guarded_start', side_effect=guarded), \
                patch.object(grant, 'tombstone', side_effect=OSError('no space')):
            self.run_pass()
        self.daemon.start.assert_called_once()
        marker = json.loads((self.home / 'forkicks-drafts' / (D1 + '.await')).read_text())
        self.assertEqual(marker['phase'], 'awaiting')
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.refused')).exists())
        self.assertEqual(self.sent, [])
        self.daemon.withdraw.assert_not_called()
        self.run_pass()
        self.assertTrue(grant.tombstoned(self.home, D1))
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())
        self.assertEqual(self.sent, [('42', grant.SUPERSEDED_LINE)])
        self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_SUPERSEDED})
        self.assertEqual(self.app.orders, {})

    def test_an_order_in_flight_without_a_tombstone_keeps_its_confirm(self):
        # A started draft whose start was never refused is an order in flight: the agent's confirm adopts it,
        # even after a newer prepare (the newest rule's only exception).
        self.prepare(D1)
        self.daemon.tap(D1)
        self.assertIn('data', self.confirm(D1))  # the agent places D1 (start + confirm)
        self.app.orders.clear()
        (self.home / 'forkicks-drafts' / (D1 + '.placed')).unlink()  # force the adoption read (no recorded receipt)
        self.prepare(D2, qty=3)
        self.assertIn('data', self.confirm(D1))  # a retry adopts the spent grant: same draft, merchant-idempotent
        self.assertEqual(self.app.orders, {D1: 1})
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.refused')).exists())

    def test_set_latest_and_the_guarded_start_share_one_lock(self):
        import threading
        self.prepare(D1)
        order = []
        with grant.drafts_lock(self.home):
            worker = threading.Thread(target=lambda: (grant.set_latest(self.home, D2), order.append('set')))
            worker.start()
            worker.join(0.3)
            self.assertTrue(worker.is_alive())  # blocked on the lock
            order.append('held')
        worker.join(5)
        self.assertEqual(order, ['held', 'set'])
        self.assertEqual(grant.guarded_start(self.home, D1, lambda: 'started'), ('superseded', None))
        self.assertEqual(grant.guarded_start(self.home, D2, lambda: 'started'), (None, 'started'))

    # ---- S2: a closed card ----------------------------------------------------------------------------

    def test_a_closed_card_read_at_confirm_says_nothing_was_ordered(self):
        self.prepare(D1)
        for state in ('expired', 'rejected', 'withdrawn', 'void'):
            with self.subTest(state=state):
                self.daemon.tap(D1, state)
                response = self.confirm(D1)
                self.assertEqual(response, {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
                self.assertIn('"Nothing was ordered. Ask me for a new preview."', response['instruction'])
                self.assertNotIn('approve', response['instruction'].lower().replace('approval card', ''))
        self.assertEqual(self.daemon.propose.call_count, 1)
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})

    # ---- quote expiry: the card is withdrawn and the draft closed (lead L20310, approval L20313) ----------

    EXPIRED_LINE = "Your For Kicks order wasn't placed: the approval or the price quote expired."

    def task(self, draft):
        return self.daemon.task_of(PREFIX + draft)

    def tombstone_of(self, draft):
        path = self.home / 'forkicks-drafts' / (draft + '.refused')
        return json.loads(path.read_text()) if path.exists() else None

    def timeouts(self):
        return [c for c in self.daemon.withdraw.call_args_list if c.args[1] == 'timeout']

    def age(self, draft, phase=None):
        marker = self.home / 'forkicks-drafts' / (draft + '.await')
        doc = json.loads(marker.read_text())
        doc['since'] = int(time.time()) - grant.TTL_S - 1
        if phase is not None:
            doc['phase'] = phase
        marker.write_text(json.dumps(doc))

    def test_a_quote_that_expires_while_its_card_waits_withdraws_the_card_and_closes_the_draft(self):
        self.prepare(D1, expires=PAST)  # the card went out; the ~5 min quote lapses before any tap
        self.run_pass()
        self.assertEqual(self.sent, [('42', self.EXPIRED_LINE)])
        self.daemon.withdraw.assert_called_once_with(self.task(D1), 'timeout', PREFIX + D1)
        self.assertEqual(self.daemon.tasks[self.task(D1)]['state'], 'withdrawn')  # no restart can re-send it
        self.assertEqual(self.tombstone_of(D1), {'code': 'expired'})
        self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
        # Even a tap that lands anyway (a card the withdraw missed): no start, no order, no second line.
        self.daemon.tap(D1)
        self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
        self.run_pass()
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})
        self.assertEqual(self.sent, [('42', self.EXPIRED_LINE)])

    def test_a_card_past_the_pass_ttl_is_withdrawn_and_its_draft_closed(self):
        self.prepare(D1)  # the quote is still live: only the marker's TTL closes it
        self.age(D1)
        self.run_pass()
        self.assertEqual(self.sent, [('42', self.EXPIRED_LINE)])
        self.daemon.withdraw.assert_called_once_with(self.task(D1), 'timeout', PREFIX + D1)
        self.assertEqual(self.tombstone_of(D1), {'code': 'expired'})
        self.daemon.tap(D1)  # a tap that lands anyway reaches the start guard: the expired tombstone, closed words
        self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
        self.run_pass()
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})
        self.assertEqual(len(self.sent), 1)

    def test_a_wait_answering_expired_or_void_closes_the_draft_too(self):
        self.prepare(D1)
        self.daemon.tap(D1, 'expired')
        self.run_pass()
        self.prepare(D2, qty=3)
        self.daemon.tap(D2, 'void')
        self.run_pass()
        self.assertEqual(self.sent, [('42', self.EXPIRED_LINE)] * 2)
        self.assertEqual(self.timeouts(), [call(self.task(D1), 'timeout', PREFIX + D1), call(self.task(D2), 'timeout', PREFIX + D2)])
        self.assertEqual((self.tombstone_of(D1), self.tombstone_of(D2)), ({'code': 'expired'}, {'code': 'expired'}))
        self.assertEqual(self.confirm(D2), {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
        self.assertEqual(self.app.orders, {})

    def test_a_withdraw_that_fails_still_sends_one_line_and_closes_the_draft(self):
        self.daemon.withdraw.side_effect = RuntimeError('timeout')
        self.prepare(D1, expires=PAST)
        self.assertEqual(self.run_pass(), None)
        self.assertEqual(self.sent, [('42', self.EXPIRED_LINE)])
        self.assertEqual(self.tombstone_of(D1), {'code': 'expired'})
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())
        self.daemon.tap(D1)  # the card stayed live in core, and the owner taps it
        self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})
        # A refused withdraw (core: already decided) and an unwritable tombstone are best effort too.
        self.daemon.withdraw.side_effect = self.daemon._withdraw
        self.prepare(D2, qty=3)
        self.age(D2)
        with patch.object(grant, 'tombstone', side_effect=OSError('no space')):
            self.run_pass()
        self.assertEqual(self.sent, [('42', self.EXPIRED_LINE)] * 2)
        self.assertIsNone(self.tombstone_of(D2))

    def test_started_or_attempted_drafts_are_never_withdrawn_or_closed_on_expiry(self):
        # A started grant is spent (core would refuse the withdraw), and an attempted one may be an order: the pass
        # keeps today's outcome for both, and leaves their cards and tombstones alone.
        self.prepare(D1, expires=PAST)
        self.daemon.tap(D1); self.daemon.tap(D1, 'started')
        self.age(D1, phase='started')  # past the TTL too
        self.run_pass()
        self.prepare(D2, qty=3)
        self.daemon.tap(D2, 'started')
        marker = self.home / 'forkicks-drafts' / (D2 + '.await')
        doc = json.loads(marker.read_text()); doc['phase'] = 'started'; marker.write_text(json.dumps(doc))
        self.run_pass()  # the quote is live: the started draft is confirmed, never withdrawn
        self.prepare(D3, qty=4)
        self.daemon.tap(D3, 'started')
        self.age(D3, phase='attempted')
        self.run_pass()
        self.assertEqual(self.timeouts(), [])
        self.assertEqual([self.tombstone_of(d) for d in (D1, D2, D3)], [None, None, None])
        self.assertEqual(self.sent[0], ('42', self.EXPIRED_LINE))
        self.assertEqual(self.app.orders, {D2: 1})
        self.assertEqual(len(self.sent), 2)  # D1's expired line, D2's placed line; D3 (may exist): no line
        # And the pass's own started-but-expired branch (no TTL): today's line, no withdraw, no tombstone.
        grant.track(self.home, D1, self.task(D1))
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        doc = json.loads(marker.read_text()); doc['phase'] = 'started'; marker.write_text(json.dumps(doc))
        (self.home / 'forkicks-drafts' / (D1 + '.line-' + self.task(D1).split(':', 1)[1])).unlink()
        self.run_pass()
        self.assertEqual(self.timeouts(), [])
        self.assertIsNone(self.tombstone_of(D1))
        self.assertEqual(self.sent[-1], ('42', self.EXPIRED_LINE))

    def test_the_agents_confirm_of_an_expired_quote_closes_the_draft_before_the_pass_does(self):
        self.prepare(D1, expires=PAST)
        response = self.confirm(D1)  # before, this said "tap Approve there and I'll place it"
        self.assertEqual(response, {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
        self.assertIn('"Nothing was ordered. Ask me for a new preview."', response['instruction'])
        self.daemon.withdraw.assert_called_once_with(self.task(D1), 'timeout', PREFIX + D1)
        self.assertEqual(self.tombstone_of(D1), {'code': 'expired'})
        self.run_pass()  # the agent told the owner: the pass closes the marker without a second message
        self.assertEqual(self.sent, [])
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())
        # Granted before the confirm read it: still no start past the quote.
        self.prepare(D2, qty=3, expires=PAST)
        self.daemon.tap(D2)
        self.assertEqual(self.confirm(D2), {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
        self.daemon.start.assert_not_called()
        # No card on record for the draft: no propose for a quote that is gone.
        self.prepare(D3, qty=4, expires=PAST)
        (self.home / 'forkicks-drafts' / (D3 + '.card')).unlink()
        proposes = self.daemon.propose.call_count
        self.assertEqual(self.confirm(D3), {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED})
        self.assertEqual(self.daemon.propose.call_count, proposes)
        self.assertEqual(self.tombstone_of(D3), {'code': 'expired'})
        self.assertEqual(self.app.orders, {})

    def test_tombstone_codes_map_to_words_and_a_corrupt_one_still_fails_closed(self):
        self.prepare(D1)
        start = Mock(return_value='started')
        grant.tombstone(self.home, D1, 'expired')
        self.assertEqual(grant.guarded_start(self.home, D1, start), ('expired', None))
        self.assertIsNone(grant.guard_adopt(self.home, D1))  # a spent grant before it: an order that may exist
        refused = self.home / 'forkicks-drafts' / (D1 + '.refused')
        for garbage, code in (('{not json', 'corrupt'), ('[]', 'corrupt'), ('{"code": "Expired!"}', 'corrupt'),
                              ('{"code": "superseded"}', 'superseded')):
            with self.subTest(garbage=garbage):
                refused.write_text(garbage)
                self.assertEqual(grant.tombstone_code(self.home, D1), code)
                self.assertEqual(grant.guarded_start(self.home, D1, start), ('refused', None))
                self.assertEqual(grant.guard_adopt(self.home, D1), 'refused')
                self.daemon.tap(D1)
                self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_SUPERSEDED})
                self.daemon.tap(D1, 'started')  # a spent grant: the adoption refuses it as well
                self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_SUPERSEDED})
        start.assert_not_called()
        self.daemon.start.assert_not_called()
        self.assertEqual(self.app.orders, {})

    def test_a_draft_the_agent_closed_between_the_pass_wait_and_its_start_is_dropped_without_a_word(self):
        # The pass read a live quote and a granted card; the agent's confirm (past the quote) closed the draft before
        # the pass took the lock: no start, no "newer preview" line (the agent already said nothing was ordered).
        self.prepare(D1)
        self.daemon.tap(D1)
        real_wait = self.daemon.wait.side_effect

        def wait(task):
            grant.close_expired(self.home, D1, None)
            return real_wait(task)

        self.daemon.wait.side_effect = wait
        self.run_pass()
        self.daemon.start.assert_not_called()
        self.assertEqual((self.sent, self.app.orders), ([], {}))
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())

    def lose_the_agents_confirm_answer(self, draft):
        """The agent's confirm starts the draft and the app creates the order, but the answer never comes back."""
        app = self.app

        def lossy(config, payload, **kw):
            out = app(config, payload, **kw)
            if payload['operation'] == 'forkicks.order.confirm':
                raise TimeoutError('answer lost')
            return out

        self.transport.side_effect = lossy
        self.assertIn('error', self.confirm(draft))
        self.transport.side_effect = app
        self.assertEqual(self.daemon.tasks[self.task(draft)]['state'], 'started')

    def test_n1_an_order_the_agent_started_is_never_told_not_placed_when_its_quote_lapses(self):
        # Review-a ov#465 N1 (probe X1): the pass's marker still says awaiting; the wait shows the agent's start.
        self.prepare(D1)
        self.daemon.tap(D1)
        self.lose_the_agents_confirm_answer(D1)
        expires = fk.quote_expires(fk.load_preview(self.home, D1, self.config))
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        doc = json.loads(marker.read_text()); doc['since'] = int(expires - 60); marker.write_text(json.dumps(doc))
        with patch('time.time', lambda: expires + 1):
            self.run_pass()
            # Never "wasn't placed" for an order that may exist. Review-a N5: the pass confirms the spent grant with the
            # same draftId and the app answers its idempotency key with the existing order: the true placed line.
            self.assertEqual(len(self.placed_lines()), 1)
            self.assertEqual(len(self.sent), 1)
            self.assertIsNone(self.tombstone_of(D1))
            self.assertEqual(self.timeouts(), [])
            self.assertFalse(marker.exists())
            retry = self.confirm(D1)  # the agent's retry answers the recorded receipt and calls nothing
            self.assertIn('data', retry)
            self.assertEqual(retry.get('instruction'), mini.ORDER_ALREADY_TOLD)
        self.assertEqual(self.app.orders, {D1: 2})  # the same draftId twice: one order at the app (idempotent key)
        self.assertEqual(len(self.sent), 1)

    def test_n1_the_ttl_branch_reads_the_wait_first_too_and_an_unreadable_wait_claims_nothing(self):
        self.prepare(D1)
        self.daemon.tap(D1)
        self.lose_the_agents_confirm_answer(D1)
        self.age(D1)
        self.run_pass()
        self.assertEqual((self.sent, self.tombstone_of(D1), self.timeouts()), ([], None, []))
        # An unreadable wait: before the TTL the marker waits for the next pass; past it, today's line, no close.
        self.prepare(D2, qty=3, expires=PAST)
        marker = self.home / 'forkicks-drafts' / (D2 + '.await')
        with patch.object(grant, 'approval_modules', side_effect=ValueError('approval_unavailable')):
            self.run_pass()
            self.assertEqual(self.sent, [])
            self.assertEqual(json.loads(marker.read_text())['phase'], 'awaiting')
            self.age(D2)
            self.run_pass()
        self.assertEqual(self.sent, [('42', self.EXPIRED_LINE)])
        self.assertIsNone(self.tombstone_of(D2))
        self.assertFalse(marker.exists())
        self.assertEqual(self.timeouts(), [])

    def test_n2_the_agents_close_between_the_pass_start_and_its_confirm_drops_the_confirm(self):
        # Review-a ov#465 N2: the agent's wait read `granted` just before the pass's start, then found the quote gone,
        # closed the draft and told the owner nothing was ordered; the pass must not send its confirm.
        self.prepare(D1)
        self.daemon.tap(D1)
        real_guarded = grant.guarded_start

        def guarded(home, draft_id, start):
            out = real_guarded(home, draft_id, start)
            grant.close_expired(self.home, D1, self.task(D1))  # the agent's close (its withdraw: already decided)
            return out

        with patch.object(grant, 'guarded_start', side_effect=guarded):
            self.run_pass()
        self.daemon.start.assert_called_once()
        self.assertEqual((self.app.orders, self.sent), ({}, []))
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())

    REFUSED_LINE = "Your For Kicks order wasn't placed: For Kicks couldn't take it."

    def merchant_past(self, expires):
        """The app as the merchant answers it: an existing order by its idempotency key, a NEW create past the quote
        refused (a 4xx, the app's lease released)."""
        app = self.app

        def answer_confirm(config, payload, **kw):
            if (payload['operation'] == 'forkicks.order.confirm' and payload['draftId'] not in app.orders
                    and time.time() >= expires):
                return {'error': 'connection_or_request_refused', 'status': 409}
            return app(config, payload, **kw)

        return answer_confirm

    def lapse_soon(self, draft):
        """The draft's quote expiry, with its marker made a minute older than it (inside the pass TTL)."""
        expires = fk.quote_expires(fk.load_preview(self.home, draft, self.config))
        marker = self.home / 'forkicks-drafts' / (draft + '.await')
        doc = json.loads(marker.read_text()); doc['since'] = int(expires - 60); marker.write_text(json.dumps(doc))
        return expires

    def confirms_sent(self):
        return [c.args[1]['draftId'] for c in self.transport.call_args_list if c.args[1]['operation'] == 'forkicks.order.confirm']

    def test_n5_the_pass_own_start_spent_and_its_answer_lost_then_the_quote_lapses_gets_one_true_line(self):
        # Review-a ov#465 N5 (probe P5): the pass's own start is spent at core, its answer is lost, and the quote lapses
        # before the next pass. Nobody confirmed, so no order exists; the owner was told they get one message.
        self.prepare(D1)
        self.daemon.tap(D1)
        real_start = self.daemon.start.side_effect

        def lossy_start(task, key, held):
            real_start(task, key, held)
            raise TimeoutError('answer lost')

        self.daemon.start.side_effect = lossy_start
        self.run_pass()
        self.daemon.start.side_effect = real_start
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        self.assertEqual(self.daemon.tasks[self.task(D1)]['state'], 'started')
        self.assertEqual(json.loads(marker.read_text())['phase'], 'awaiting')
        self.assertEqual((self.app.orders, self.sent, self.confirms_sent()), ({}, [], []))
        expires = self.lapse_soon(D1)
        self.transport.side_effect = self.merchant_past(expires)
        with patch('time.time', lambda: expires + 1):
            self.run_pass()
        # The confirm went out once, with the same draftId; the app refused the new create: the true "wasn't placed".
        self.assertEqual(self.confirms_sent(), [D1])
        self.assertEqual(self.app.orders, {})
        self.assertEqual(self.sent, [('42', self.REFUSED_LINE)])
        self.assertFalse(marker.exists())
        self.assertEqual((self.tombstone_of(D1), self.timeouts()), (None, []))
        self.daemon.start.assert_called_once()  # no second start: the spent grant's own task and bytes

    def test_n9_a_late_confirm_after_the_agents_expired_close_sends_nothing(self):
        # Review-a ov#468 N9 (Q5b): the pass's own start is spent with its answer lost; the agent then finds the quote
        # gone, closes the draft (`expired`) and tells the owner nothing was ordered. With the merchant's clock behind
        # the box's, a late confirm would still create an order: the tombstone stops it before the transport.
        self.prepare(D1)
        self.daemon.tap(D1)
        real_start = self.daemon.start.side_effect

        def lossy_start(task, key, held):
            real_start(task, key, held)
            raise TimeoutError('answer lost')

        self.daemon.start.side_effect = lossy_start
        self.run_pass()
        self.daemon.start.side_effect = real_start
        expires = self.lapse_soon(D1)
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        real_spent = grant._spent

        def spent_then_agent_closes(waited, key):  # the pass read the wait; the agent's close lands right after
            out = real_spent(waited, key)
            grant.close_expired(self.home, D1, self.task(D1))
            return out

        with patch('time.time', lambda: expires + 1), patch.object(grant, '_spent', side_effect=spent_then_agent_closes):
            self.run_pass()  # the app (the merchant's clock behind) would still accept a create
        self.assertEqual((self.confirms_sent(), self.app.orders, self.sent), ([], {}, []))
        self.assertFalse(marker.exists())
        self.assertEqual(self.tombstone_of(D1), {'code': 'expired'})

    def test_n5_a_late_confirm_that_gets_no_answer_is_retried_with_the_same_draftid_never_a_second_line(self):
        self.prepare(D1)
        self.daemon.tap(D1)
        self.lose_the_agents_confirm_answer(D1)
        expires = self.lapse_soon(D1)
        app = self.app
        busy = [True]

        def leased(config, payload, **kw):  # the agent's confirm still holds the app's lease on the first try
            if payload['operation'] == 'forkicks.order.confirm' and busy[0]:
                busy[0] = False
                return {'error': 'forkicks_confirm_in_progress'}
            return app(config, payload, **kw)

        self.transport.side_effect = leased
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        with patch('time.time', lambda: expires + 1):
            self.run_pass()
            self.assertEqual(json.loads(marker.read_text())['phase'], 'attempted')
            self.assertEqual(self.sent, [])
            self.run_pass()
        self.assertEqual(self.confirms_sent(), [D1, D1, D1])  # the agent's lost one, then the pass's two
        self.assertEqual(self.app.orders, {D1: 2})  # one order at the app (idempotent key)
        self.assertEqual(len(self.placed_lines()), 1)
        self.assertEqual(len(self.sent), 1)
        self.assertFalse(marker.exists())

    # ---- review-a ov#465 N8, product ruling (i): the newest-draft check reads the wait first ---------------------

    def superseded_withdraws(self, draft):
        return self.daemon.withdraw.call_args_list.count(call(self.task(draft), 'superseded', PREFIX + draft))

    def test_n8_an_older_draft_the_agent_started_is_refused_without_the_nothing_was_ordered_line(self):
        # Probe P9: the agent's confirm starts D1 and the app creates the order, but the answer is lost; D2 is prepared
        # and tapped before the pass reads D1. D1 is still refused for good (tombstone + withdraw), with no line.
        self.prepare(D1)
        self.daemon.tap(D1)
        self.lose_the_agents_confirm_answer(D1)
        self.prepare(D2, qty=3)  # D1's withdraw here is refused by core (already decided): its grant is spent
        self.daemon.tap(D2)
        withdraws = self.superseded_withdraws(D1)
        self.run_pass()
        self.assertNotIn(('42', grant.SUPERSEDED_LINE), self.sent)  # "Nothing was ordered" could be false here
        self.assertEqual(self.tombstone_of(D1), {'code': 'superseded'})
        self.assertEqual(self.superseded_withdraws(D1), withdraws + 1)  # the withdraw, exactly as before
        self.assertFalse((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())
        self.assertEqual(self.app.orders, {D1: 1, D2: 1})  # D1's order predates the pass, which added only D2's
        self.assertEqual(self.confirms_sent().count(D1), 1)  # the agent's lost confirm only: never the pass
        self.assertEqual(len(self.placed_lines()), 1)
        self.assertEqual(len(self.sent), 1)  # D2's placed line, nothing about D1

    def test_n8_case_a_the_pass_own_refused_start_with_an_unwritable_tombstone_places_only_the_newest(self):
        # The pass starts D1, D2's prepare lands before its confirm, and the tombstone cannot be written: the retry
        # (marked ownStart) keeps today's refusal and line without a wait read, and the agent can never place D1.
        self.prepare(D1)
        self.daemon.tap(D1)
        real_guarded = grant.guarded_start

        def guarded(home, draft_id, start):
            out = real_guarded(home, draft_id, start)
            grant.set_latest(self.home, D2)
            return out

        with patch.object(grant, 'guarded_start', side_effect=guarded), \
                patch.object(grant, 'tombstone', side_effect=OSError('no space')):
            self.run_pass()
        marker = json.loads((self.home / 'forkicks-drafts' / (D1 + '.await')).read_text())
        self.assertEqual((marker['phase'], marker.get('ownStart')), ('awaiting', True))
        self.prepare(D2, qty=3)
        self.daemon.tap(D2)
        self.run_pass(); self.run_pass()
        self.assertEqual(self.tombstone_of(D1), {'code': 'superseded'})
        self.assertIn(('42', grant.SUPERSEDED_LINE), self.sent)  # nothing was sent for D1: the line is true
        self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_SUPERSEDED})
        self.assertEqual(self.app.orders, {D2: 1})

    def test_n8_case_b_the_pass_own_start_answer_lost_then_a_newer_prepare_places_only_the_newest(self):
        # The pass's own start is spent with its answer lost (marker still awaiting), then D2 is prepared and tapped.
        # The wait reads spent: D1 is tombstoned and withdrawn with no line, and the agent can never place D1.
        self.prepare(D1)
        self.daemon.tap(D1)
        real_start = self.daemon.start.side_effect

        def lossy_start(task, key, held):
            real_start(task, key, held)
            raise TimeoutError('answer lost')

        self.daemon.start.side_effect = lossy_start
        self.run_pass()
        self.daemon.start.side_effect = real_start
        self.prepare(D2, qty=3)
        self.daemon.tap(D2)
        self.run_pass(); self.run_pass()
        self.assertEqual(self.tombstone_of(D1), {'code': 'superseded'})
        self.assertNotIn(('42', grant.SUPERSEDED_LINE), self.sent)
        self.assertEqual(self.confirm(D1), {'error': 'approval_card_closed', 'instruction': mini.ORDER_SUPERSEDED})
        self.assertEqual(self.app.orders, {D2: 1})
        self.assertEqual(self.confirms_sent(), [D2])

    def test_n8_a_not_spent_older_draft_reads_the_wait_and_keeps_the_line_and_an_unreadable_wait_too(self):
        self.prepare(D1)
        self.daemon.withdraw.side_effect = RuntimeError('timeout')  # D1's card stays live
        self.prepare(D2, qty=3)
        self.daemon.withdraw.side_effect = self.daemon._withdraw
        self.daemon.tap(D1)  # a tap on the old card: granted, never started
        self.daemon.wait.reset_mock()  # the prepares' own reads (card at prepare) do not count
        self.run_pass()
        self.assertIn(call(self.task(D1)), self.daemon.wait.call_args_list)  # the pass read D1's wait first
        self.daemon.start.assert_not_called()
        self.assertEqual(self.sent, [('42', grant.SUPERSEDED_LINE)])
        self.assertEqual(self.tombstone_of(D1), {'code': 'superseded'})
        # An unreadable wait: today's refusal, its line and its tombstone.
        self.prepare(D3, qty=4)
        with patch.object(grant, 'approval_modules', side_effect=ValueError('approval_unavailable')):
            self.run_pass()
        self.assertEqual(self.sent[-1], ('42', grant.SUPERSEDED_LINE))
        self.assertEqual(self.tombstone_of(D2), {'code': 'superseded'})
        self.assertEqual(self.app.orders, {})

    def test_an_expired_tombstone_keeps_an_order_in_flight_recoverable(self):
        # The grant was spent before the pass closed the draft (a start before the quote lapsed): the confirm is still
        # sent with the same draftId, and the app answers its idempotency key.
        self.prepare(D1)
        self.daemon.tap(D1, 'started')
        grant.tombstone(self.home, D1, 'expired')
        self.assertIn('data', self.confirm(D1))
        self.assertEqual(self.app.orders, {D1: 1})

    # ---- S3: the spent-grant adoption branch (review-a RA41 probes, copied) ---------------------------

    def test_forged_card_marker_with_another_drafts_granted_task_never_places(self):
        """Agent shell writes D2.card = D1's (granted) task: core's key binding + the box's action_key filter hold."""
        self.prepare(D1); self.prepare(D2, qty=3)
        self.daemon.tap(D1)
        t1 = self.daemon.task_of(PREFIX + D1)
        card = self.home / 'forkicks-drafts' / (D2 + '.card')
        card.unlink(); card.write_text(json.dumps({'task': t1}))
        self.assertIn('error', self.confirm(D2))
        self.assertNotIn(D2, self.app.orders)
        # and once D1's grant is spent (nothing-to-wait-for, D1's action granted): the adoption branch must not adopt it
        self.daemon.tasks[t1]['state'] = 'started'
        self.assertIn('error', self.confirm(D2))
        self.assertNotIn(D2, self.app.orders)

    def test_adoption_needs_exit0_and_this_drafts_action_granted(self):
        """Kills R2/R3: a spent-grant read is adopted only with exit 0 AND this draft's own action `granted`."""
        self.prepare(D1)
        t1 = self.daemon.task_of(PREFIX + D1)
        for code, state in ((0, 'rejected'), (0, 'withdrawn'), (1, 'granted'), (3, 'granted')):
            with self.subTest(code=code, state=state):
                self.daemon.wait.side_effect = lambda task, code=code, state=state: answer(
                    code, ok=True, task=task, status='nothing-to-wait-for', actions=[{'action_key': PREFIX + D1, 'state': state}])
                self.assertIn('error', self.confirm(D1))
                self.assertEqual(self.app.orders, {})
        self.daemon.start.assert_not_called()

    # ---- N5: the For Kicks fast poll ---------------------------------------------------------------------

    def test_fast_poll_wakes_the_poller_every_2_s_only_while_a_card_awaits(self):
        ap = Mock(); ap.poller_alive.return_value = True
        sleeps = []
        bridge._forkicks_tick(self.home, ap, sleep=sleeps.append)  # no marker: no sleep, no work
        self.assertEqual((sleeps, ap.kick.call_count), ([], 0))
        self.prepare(D1)
        marker = self.home / 'forkicks-drafts' / (D1 + '.await')
        self.assertTrue(marker.exists())

        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 3:
                marker.unlink()  # the pass closed it (placed / denied / expired)

        bridge._forkicks_tick(self.home, ap, sleep=sleep)
        self.assertEqual(sleeps, [2.0, 2.0, 2.0])
        self.assertEqual(ap.kick.call_count, 3)
        self.assertLess(bridge._forkicks_poll_s() + 1.0, 5.0)  # one interval + a pass stays under Carter's 5 s
        for raw, expected in (('0.2', 1.0), ('3', 3.0), ('nan', 2.0), ('x', 2.0), ('900', 30.0), ('', 2.0)):
            with patch.dict(os.environ, {'AV_FORKICKS_POLL_S': raw}):
                self.assertEqual(bridge._forkicks_poll_s(), expected)
        ap.poller_alive.return_value = False  # no poller: no kick (never a one-shot pass every 2 s)
        self.prepare(D2, qty=3)
        marker = self.home / 'forkicks-drafts' / (D2 + '.await')
        sleeps.clear()
        bridge._forkicks_tick(self.home, ap, sleep=lambda s: marker.unlink() if marker.exists() else None)
        self.assertEqual(ap.kick.call_count, 3)

    def test_the_ticker_starts_after_the_card_is_tracked(self):
        with patch.object(bridge, '_ensure_forkicks_ticker') as ticker:
            self.prepare(D1)
        ticker.assert_called_once_with(self.home)
        self.assertTrue((self.home / 'forkicks-drafts' / (D1 + '.await')).exists())


if __name__ == '__main__':
    unittest.main()
