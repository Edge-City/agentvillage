"""RA42 ov S1 + M1: the box's projection() refuses a GENERIC entry PER APP (the other apps of the file stay installed),
while the structure and the reviewed entries stay whole-file (the tamper signal). The shared projection-entry vectors
(`vectors/mini-app-projection-entry.json`, byte-identical in the cp, sha256 pinned here and there) run case by case:
each `entry` (or `legacyEntry`, what the old cp#352 would have served for a dropped case) beside the reviewed Gold
Stars and For Kicks entries. Offline; all data invented."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
mini = fixture.mini
mc = sys.modules['village_bridge._mini_app_card']

VECTOR_FILE = Path(__file__).with_name('vectors').joinpath('mini-app-projection-entry.json')
VECTOR_SHA256 = '25c5358fc846f98f4f64efbb7b397f72b29b4f1f7b2545095c2c549843359816'  # the cp's test pins the same bytes
VECTORS = json.loads(VECTOR_FILE.read_text(encoding='utf-8'))
GOLD = {'id': 'gold-stars', **mini.GOLD_STARS}
FORKICKS = {'id': 'forkicks', **mini.FORKICKS}
REVIEWED = {'gold-stars-reviewed': GOLD, 'forkicks-reviewed': FORKICKS}
CASES = {case['name']: case for case in VECTORS['cases']}
ACME_FIXTURE = CASES['acme-fixture-other-ops']['legacyEntry']  # RA42's acme: other ops + prepare + confirm
CARD_ONLY = CASES['card-only']['entry']


def served(case):
    """The entry the box is fed: the cp's emitted entry, or for a dropped case what the old cp#352 served."""
    return copy.deepcopy(case['entry'] if case['entry'] is not None else case['legacyEntry'])


def renamed(entry, new_id):
    """`entry` under another app id, its op prefixes (and approval op names) following."""
    old = entry['id']
    move = lambda op: new_id + op[len(old):] if op.startswith(old + '.') else op  # noqa: E731
    out = {**copy.deepcopy(entry), 'id': new_id, 'skills': [new_id], 'operations': [move(op) for op in entry['operations']]}
    if 'approval' in entry:
        out['approval'] = {**entry['approval'], 'prepare': move(entry['approval']['prepare']), 'card': move(entry['approval']['card'])}
    return out


class ProjectionEntryTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name).resolve()
        getattr(mini, '_REFUSED_LOGGED', set()).clear()  # the log-once memory, fresh per test

    def write(self, *apps):
        Path(self.home, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': list(apps)}))

    def assert_reviewed_installed(self):
        self.assertTrue(mini.installed(self.home, 'gold-stars', 'gold-stars.send'))
        self.assertTrue(mini.installed(self.home, 'forkicks', 'forkicks.order.confirm'))

    def assert_accepted(self, entry):
        app_id = entry['id']
        self.assertEqual([app['id'] for app in mini.projection(self.home)], ['gold-stars', 'forkicks', app_id])
        for op in entry['operations']:
            self.assertTrue(mini.installed(self.home, app_id, op), op)
        if 'approval' in entry:
            card, prepare = entry['approval']['card'], entry['approval']['prepare']
            self.assertEqual(mc.projected_operation(self.home, card)[2]['class'], 'needs-card')
            self.assertEqual(mc.projected_operation(self.home, prepare)[2]['class'], 'prepare')
        else:
            for op in entry['operations']:
                self.assertIsNone(mc.projected_operation(self.home, op))

    def assert_refused_alone(self, entry):
        app_id = entry['id']
        self.assertNotIn(app_id, [app['id'] for app in mini.projection(self.home)])
        for op in entry['operations']:
            self.assertFalse(mini.installed(self.home, app_id, op), op)
            self.assertIsNone(mc.projected_operation(self.home, op))
        self.assert_reviewed_installed()

    # ---- the shared vectors ------------------------------------------------------------------------------------------

    def test_vector_file_is_the_pinned_shared_bytes(self):
        self.assertEqual(hashlib.sha256(VECTOR_FILE.read_bytes()).hexdigest(), VECTOR_SHA256)
        self.assertEqual(VECTORS['version'], 1)
        self.assertEqual(len(VECTORS['cases']), 13)
        self.assertEqual(len(CASES), 13)  # names are unique

    def test_every_vector_case_against_projection(self):
        for case in VECTORS['cases']:
            with self.subTest(case['name']):
                self.assertIn(case['box'], ('accepted', 'refused'))
                self.assertEqual(case['entry'] is None, case['cp'] == 'dropped')
                entry = served(case)
                self.write(GOLD, FORKICKS, entry)
                if case['box'] == 'accepted':
                    self.assert_accepted(entry)
                else:
                    self.assert_refused_alone(entry)

    def test_file_cases(self):
        self.assertEqual(len(VECTORS['fileCases']), 1)
        for file_case in VECTORS['fileCases']:
            with self.subTest(file_case['name']):
                apps, ids = [], {}
                for ref in file_case['apps']:
                    if ref in REVIEWED:
                        apps.append(copy.deepcopy(REVIEWED[ref]))
                        continue
                    name, key = ref.rsplit('.', 1)
                    entry = copy.deepcopy(CASES[name][key])
                    if any(app['id'] == entry['id'] for app in apps):
                        entry = renamed(entry, entry['id'] + '2')  # the note: the second acme becomes acme2
                    ids[name] = entry['id']
                    apps.append(entry)
                self.assertEqual(len({app['id'] for app in apps}), len(apps))
                self.write(*apps)
                expected = [ids[ref.split('@', 1)[1]] if '@' in ref else ref for ref in file_case['box']['installed']]
                self.assertEqual([app['id'] for app in mini.projection(self.home)], expected)
                for name in file_case['box']['refused']:
                    self.assertFalse(any(mini.installed(self.home, ids[name], op) for op in CASES[name]['legacyEntry']['operations']))
                card = next(app for app in apps if app['id'] == ids['card-only'])
                self.assertEqual(mc.projected_operation(self.home, card['approval']['card'])[2]['class'], 'needs-card')

    # ---- RA42 ov N4: a card entry's version is checked (mutant K6) ---------------------------------------------------

    def test_a_card_entry_with_a_bad_version_is_refused_alone(self):
        for version in ('1.0.0-beta.1', '1.0', 'v1.0.0', '', 1):
            with self.subTest(repr(version)):
                bad = {**copy.deepcopy(CARD_ONLY), 'version': version}
                self.write(GOLD, FORKICKS, bad)
                self.assert_refused_alone(bad)
        self.write(GOLD, FORKICKS, copy.deepcopy(CARD_ONLY))
        self.assert_accepted(CARD_ONLY)

    # ---- per app vs whole file (RA42 ov S1) --------------------------------------------------------------------------

    def test_one_bad_generic_installs_the_other_three(self):
        good = renamed(CARD_ONLY, 'acme2')
        self.write(GOLD, FORKICKS, ACME_FIXTURE, good)
        self.assertEqual([app['id'] for app in mini.projection(self.home)], ['gold-stars', 'forkicks', 'acme2'])
        self.assert_refused_alone(ACME_FIXTURE)
        self.assertTrue(mini.installed(self.home, 'acme2', 'acme2.order.confirm'))
        self.assertEqual(mc.projected_operation(self.home, 'acme2.order.confirm')[2]['class'], 'needs-card')
        # The bad entry anywhere in the file: still refused alone.
        self.write(ACME_FIXTURE, GOLD, good, FORKICKS)
        self.assertEqual([app['id'] for app in mini.projection(self.home)], ['gold-stars', 'acme2', 'forkicks'])

    def test_each_generic_check_refuses_per_app(self):
        good = renamed(CARD_ONLY, 'acme2')
        plain = {'id': 'dizko', 'version': '1.0.0', 'skills': ['dizko'], 'operations': ['mini-app.read']}
        bad = [
            {**plain, 'id': 'Dizko', 'skills': ['Dizko']}, {**plain, 'id': '2dizko', 'skills': ['2dizko']},  # id regex
            {**plain, 'id': 'd' * 65, 'skills': ['d' * 65]}, {**plain, 'id': ''},
            {**plain, 'version': '1.0'}, {**plain, 'version': 1}, {**plain, 'skills': []}, {**plain, 'skills': ['other']},
            {**plain, 'operations': ['mini-app.read', 'gold-stars.send']}, {**plain, 'operations': None},
            {k: v for k, v in plain.items() if k != 'skills'}, {**plain, 'extra': 1},
            {**plain, 'approval': None}, {**plain, 'approval': {'prepare': 'dizko.a.prepare', 'card': 'dizko.a.confirm'}},
            {**CARD_ONLY, 'approval': {**CARD_ONLY['approval'], 'card': CARD_ONLY['approval']['prepare']}},
            {**CARD_ONLY, 'approval': {'prepare': 'acme.order.prepare', 'card': 'acme.order.confirm', 'fields': {}, 'bind': []}},
        ]
        for entry in bad:
            with self.subTest(entry=entry):
                self.write(GOLD, FORKICKS, entry, good)
                self.assertEqual([app['id'] for app in mini.projection(self.home)], ['gold-stars', 'forkicks', 'acme2'])
                self.assert_reviewed_installed()

    def test_a_tampered_reviewed_entry_still_refuses_the_whole_file(self):
        zzz, slop = {'id': 'zzzbot', **mini.ZZZBOT}, {'id': 'slopfolio', **mini.SLOPFOLIO}
        tampered = [
            {**GOLD, 'operations': GOLD['operations'] + ['mini-app.context.write']}, {**GOLD, 'version': '1.1.1'},
            {**FORKICKS, 'approval': {'prepare': 'forkicks.order.prepare', 'card': 'forkicks.order.confirm'}},
            {**FORKICKS, 'operations': FORKICKS['operations'][:-1]}, {**zzz, 'skills': ['zzz']}, {**slop, 'extra': 1},
        ]
        for entry in tampered:
            with self.subTest(entry=entry):
                others = [app for app in (GOLD, FORKICKS, zzz, slop) if app['id'] != entry['id']]
                self.write(*others, entry, CARD_ONLY)
                self.assertIsNone(mini.projection(self.home))
                self.assertFalse(mini.installed(self.home, 'acme', 'acme.order.confirm'))
                for app in others:
                    self.assertFalse(mini.installed(self.home, app['id'], app['operations'][0]))

    def test_structure_stays_whole_file(self):
        bad_twice = renamed(ACME_FIXTURE, 'acme2')
        for apps in ([GOLD, CARD_ONLY, CARD_ONLY], [GOLD, ACME_FIXTURE, CARD_ONLY], [GOLD, CARD_ONLY, ACME_FIXTURE],
                     [GOLD, bad_twice, bad_twice], [GOLD, GOLD], [GOLD, 'acme'], [GOLD, None], [GOLD, ['acme']],
                     [GOLD, {**CARD_ONLY, 'id': 7}], [GOLD, {k: v for k, v in CARD_ONLY.items() if k != 'id'}]):
            with self.subTest(apps=apps):
                self.write(*apps)
                self.assertIsNone(mini.projection(self.home))
                self.assertFalse(mini.installed(self.home, 'gold-stars', 'gold-stars.send'))
        for doc in ({'version': 2, 'apps': [GOLD]}, {'version': 1, 'apps': [GOLD], 'x': 1}, {'apps': [GOLD]}, [GOLD]):
            with self.subTest(doc=doc):
                Path(self.home, 'mini-apps.json').write_text(json.dumps(doc))
                self.assertIsNone(mini.projection(self.home))

    def test_refusal_is_logged_once_with_the_id_only(self):
        self.write(GOLD, FORKICKS, ACME_FIXTURE)
        with self.assertLogs('village_bridge', level='WARNING') as logs:
            for _ in range(3):
                self.assertFalse(mini.installed(self.home, 'acme', 'acme.order.confirm'))
        self.assertEqual(logs.output, ['WARNING:village_bridge:village_bridge mini_apps.entry_refused app=acme'])
        # An id outside the logged shape is never printed.
        self.write(GOLD, {**ACME_FIXTURE, 'id': 'A\ncme <x>', 'skills': ['A\ncme <x>']})
        with self.assertLogs('village_bridge', level='WARNING') as logs:
            mini.projection(self.home)
        self.assertEqual(logs.output, ['WARNING:village_bridge:village_bridge mini_apps.entry_refused app=invalid'])


if __name__ == '__main__':
    unittest.main()
