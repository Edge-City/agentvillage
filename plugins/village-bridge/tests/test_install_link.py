"""MINIAPP-INSTALL-LINK (v2.1.5): a not-installed app's refusal carries its one-tap Mini-apps link from the reviewed
catalog, only for an app the control plane says this resident can open; the install words never send the resident
to the team; the installable list is generated from the catalog."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
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
link = sys.modules['village_bridge._install_link']
catalog = sys.modules['village_bridge._install_catalog']
copy = sys.modules['village_bridge._install_copy']

REPO = Path(__file__).resolve().parents[3]
GENERATOR = REPO / 'scripts' / 'gen_install_catalog.py'
_gen_spec = importlib.util.spec_from_file_location('gen_install_catalog', GENERATOR)
gen = importlib.util.module_from_spec(_gen_spec)
_gen_spec.loader.exec_module(gen)

PAGE = 'https://agents.edgecity.live/mini-apps?app='
MANIFESTS = {p.parent.name: json.loads(p.read_text(encoding='utf-8')) for p in sorted((REPO / 'mini-apps').glob('*/manifest.json'))}
ALL = ','.join(MANIFESTS)
# Apps that come with every agent (manifest "staff": true; cp#322): never an install link, never installable.
STAFF_IDS = [app_id for app_id, doc in MANIFESTS.items() if doc.get('staff') is True]
INSTALLABLE_IDS = [app_id for app_id in MANIFESTS if app_id not in STAFF_IDS]
# One operation per catalog app (Rolodex rides the Gold Stars install). The installed() check runs before any
# argument validation, so the operation alone (plus an appId for the generic app ops) reaches the refusal.
REQUESTS = {
    'gold-stars': [{'operation': 'gold-stars.quota'}, {'operation': 'rolodex.search', 'query': 'Naman'}, {'operation': 'rolodex.person', 'query': 'Lena'}],
    'forkicks': [{'operation': 'forkicks.menu'}],
    'slopfolio': [{'operation': 'slopfolio.status', 'draftId': '550e8400-e29b-41d4-a716-446655440000'}],
    'zzzbot': [{'operation': 'zzz.list_rooms', 'arguments': {}}],
    'dizko': [{'operation': 'mini-app.read', 'appId': 'dizko', 'tool': 'search', 'arguments': {}}],
}
# Sentences about the team or the organisers are allowed only as prohibitions.
TEAM = re.compile(r"\b(team|organi[sz]ers?|staff|support)\b", re.I)
NEGATION = re.compile(r"\b(never|do not|don't|not)\b", re.I)


def team_referrals(text):
    """Sentences that mention the team/organisers without forbidding the referral."""
    sentences = re.split(r"(?<=[.!?:;])\s+", " ".join(text.split()))
    return [s for s in sentences if TEAM.search(s) and not NEGATION.search(s)]


class InstallLinkTest(unittest.TestCase):
    setUp = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def offer(self, value):
        p = patch.dict(os.environ, {'AV_MINI_APPS_OFFERED': value}); p.start(); self.addCleanup(p.stop)

    def nothing_installed(self):
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': []}))

    def test_the_refusal_carries_each_catalog_apps_link(self):
        self.offer(ALL)
        self.nothing_installed()
        self.assertEqual(set(REQUESTS), set(MANIFESTS))
        for app_id, requests in REQUESTS.items():
            if app_id in STAFF_IDS:
                continue  # test_a_staff_app_never_gets_an_install_link
            for args in requests:
                with self.subTest(app=app_id, op=args['operation']):
                    out = self.call(args)
                    self.assertEqual(out['error'], 'mini_app_not_installed')
                    self.assertEqual(out['installUrl'], PAGE + app_id)
                    self.assertEqual(out['appName'], MANIFESTS[app_id]['name'])
                    self.assertEqual(out['instruction'], copy.NOT_INSTALLED)
                    self.assertEqual(out['handling'], bridge.HANDLING)
                    self.assertEqual([a['id'] for a in out['installable']], sorted(set(INSTALLABLE_IDS) - {app_id}))
                    for app in out['installable']:
                        self.assertEqual(app, {'id': app['id'], 'name': MANIFESTS[app['id']]['name'],
                                               'description': MANIFESTS[app['id']]['description'], 'installUrl': PAGE + app['id']})
        self.transport.assert_not_called()

    def test_no_mini_app_state_at_all_still_gets_the_link(self):
        # The screenshot's box: nothing ever installed, so no mini-apps.json on disk.
        self.offer(ALL)
        Path(self.tmp.name, 'mini-apps.json').unlink()
        out = self.call({'operation': 'forkicks.menu'})
        self.assertEqual((out['error'], out['appName'], out['installUrl']), ('mini_app_not_installed', 'For Kicks', PAGE + 'forkicks'))
        # Its Rolodex op: Gold Stars comes with every agent, so it is on its way, never an install link.
        out = self.call({'operation': 'rolodex.search', 'query': 'Naman'})
        self.assertEqual(out['instruction'], copy.STAFF_PENDING.format(name='Gold Stars')); self.assertNotIn('installUrl', out)
        self.transport.assert_not_called()

    def test_no_link_for_an_unknown_operation_or_app(self):
        self.offer(ALL)
        self.nothing_installed()
        for args in ({'operation': 'rolodex.install'}, {'operation': 'install_request', 'appId': 'gold-stars'}, {'operation': 'mini-app.install'}):
            with self.subTest(op=args['operation']):
                out = self.call(args)
                self.assertNotEqual(out['error'], 'mini_app_not_installed')
                self.assertNotIn('installUrl', json.dumps(out)); self.assertNotIn(PAGE, json.dumps(out))
        # An appId outside the reviewed catalog: the closed code, no link, and the caller's text is never echoed.
        for app_id in ('rolodex', 'evil', 'https://evil.example/x', 'gold-stars-x', 'GOLD-STARS', '', 7):
            with self.subTest(appId=app_id):
                out = self.call({'operation': 'mini-app.read', 'appId': app_id, 'tool': 'search', 'arguments': {}})
                self.assertEqual(out['error'], 'mini_app_not_installed')
                self.assertNotIn('installUrl', out); self.assertNotIn('appName', out)
                self.assertEqual(out['instruction'], copy.NOT_OFFERED)
                if isinstance(app_id, str) and app_id:
                    self.assertNotIn(app_id, json.dumps(out))
        self.transport.assert_not_called()

    def test_a_link_only_for_an_app_this_resident_can_open(self):
        self.nothing_installed()
        # Unset, empty or malformed: the box cannot know the resident sees Mini-apps, so no link at all (a 404 otherwise).
        for value in (None, '', ' ', 'gold-stars,', 'gold-stars,,dizko', 'gold-stars;dizko', '*', 'Gold-Stars', 'gold-stars,gold-stars',
                      'https://agents.edgecity.live/mini-apps?app=gold-stars'):
            with self.subTest(offered=value):
                env = {k: v for k, v in os.environ.items() if k != 'AV_MINI_APPS_OFFERED'}
                if value is not None:
                    env['AV_MINI_APPS_OFFERED'] = value
                with patch.dict(os.environ, env, clear=True):
                    out = self.call({'operation': 'forkicks.menu'})
                self.assertEqual(out['error'], 'mini_app_not_installed')
                self.assertNotIn('installUrl', out); self.assertEqual(out['installable'], [])
                self.assertEqual(out['instruction'], copy.NOT_OFFERED); self.assertEqual(out['handling'], bridge.HANDLING)
        # A restricted app the cp does not offer this tenant (zzz.bot, Slopfolio): no link, and not suggested.
        self.offer('gold-stars, forkicks,dizko')
        out = self.call({'operation': 'zzz.list_rooms', 'arguments': {}})
        self.assertNotIn('installUrl', out); self.assertEqual(out['instruction'], copy.NOT_OFFERED)
        self.assertEqual([a['id'] for a in out['installable']], ['dizko', 'forkicks'])  # a staff id named there is ignored
        # An id the cp names that the reviewed catalog does not carry is ignored, never turned into a link.
        self.offer('forkicks,rolodex')
        out = self.call({'operation': 'mini-app.read', 'appId': 'rolodex', 'tool': 'search', 'arguments': {}})
        self.assertNotIn('installUrl', out); self.assertEqual([a['id'] for a in out['installable']], ['forkicks'])

    def test_an_installed_app_missing_the_operation_gets_no_install_link(self):
        # Gold Stars installed under the 8-op entry: rolodex.person is refused, but the sheet would say "Installed".
        self.offer(ALL)
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'gold-stars', **mini.GOLD_STARS_RESTORED}]}))
        out = self.call({'operation': 'rolodex.person', 'query': 'Lena'})
        self.assertEqual(out['error'], 'mini_app_not_installed'); self.assertEqual(out['instruction'], copy.NOT_YET.format(name='Gold Stars'))
        self.assertIn("'Gold Stars is installed, but that action isn't ready on your agent yet. Try again in a minute.'", out['instruction'])
        self.assertNotIn('installUrl', out)
        self.assertNotIn('gold-stars', [a['id'] for a in out['installable']])
        # Installed apps are never suggested again.
        out = self.call({'operation': 'forkicks.menu'})
        self.assertEqual(out['installUrl'], PAGE + 'forkicks')
        self.assertEqual([a['id'] for a in out['installable']], sorted(set(INSTALLABLE_IDS) - {'forkicks'}))

    def test_a_staff_app_never_gets_an_install_link(self):
        # Product L13443: a staff app (Gold Stars, which Rolodex rides) answers NOT_YET's words, never an install link,
        # whatever the cp offers and whatever else is on the box.
        self.assertEqual(STAFF_IDS, ['gold-stars'])
        pending = copy.STAFF_PENDING.format(name='Gold Stars')
        self.assertIn("Tell them: '**Gold Stars** is on its way to your agent. Try again in a minute.'", pending)
        self.assertIn('do not send an install link', pending)
        states = {'no file': None, 'empty': [], 'other app': [{'id': 'forkicks', **mini.FORKICKS}]}
        for offered_value in (ALL, 'gold-stars', 'gold-stars,forkicks', None):
            for state, apps in states.items():
                for args in REQUESTS['gold-stars'] + [{'operation': 'rolodex.meeting', 'attendeeId': 'x', 'met': True},
                                                       {'operation': 'skylight.status'}, {'operation': 'gold-stars.send', 'draftId': 'x'}]:
                    with self.subTest(offered=offered_value, state=state, op=args['operation']):
                        env = {k: v for k, v in os.environ.items() if k != 'AV_MINI_APPS_OFFERED'}
                        if offered_value is not None:
                            env['AV_MINI_APPS_OFFERED'] = offered_value
                        home = Path(self.tmp.name, 'mini-apps.json')
                        if apps is None:
                            home.unlink(missing_ok=True)
                        else:
                            home.write_text(json.dumps({'version': 1, 'apps': apps}))
                        with patch.dict(os.environ, env, clear=True):
                            out = self.call(args)
                        self.assertEqual(out['error'], 'mini_app_not_installed')
                        self.assertEqual(out['instruction'], pending)
                        self.assertNotIn('installUrl', out); self.assertNotIn('appName', out)
                        self.assertNotIn(PAGE + 'gold-stars', json.dumps(out, ensure_ascii=False))
                        self.assertNotIn('gold-stars', [a['id'] for a in out['installable']])
                        self.assertEqual(out['handling'], bridge.HANDLING)
        # The post-approval recheck answers the same.
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': []}))
        self.offer(ALL)
        refusal = link.not_installed(Path(self.tmp.name), 'gold-stars', bridge.HANDLING)
        self.assertEqual(refusal['instruction'], pending); self.assertNotIn('installUrl', refusal)
        # The staff mark lives only in the reviewed catalog: no link for it exists anywhere the agent reads.
        self.assertEqual([a['id'] for a in catalog.STAFF], STAFF_IDS)
        self.assertTrue(all('installUrl' not in a for a in catalog.STAFF))
        self.assertNotIn('gold-stars', [a['id'] for a in link.offered({'AV_MINI_APPS_OFFERED': ALL})])
        skill = (REPO / 'skills' / 'mini-apps' / 'SKILL.md').read_text(encoding='utf-8')
        for name in ('mini-apps', 'rolodex', 'gold-stars'):
            self.assertNotIn(PAGE + 'gold-stars', (REPO / 'skills' / name / 'SKILL.md').read_text(encoding='utf-8'))
        self.assertIn(copy.STAFF_INTRO, skill); self.assertIn('> ' + copy.STAFF_TELL.format(name='Gold Stars'), skill)
        self.transport.assert_not_called()

    def test_an_unlisted_manifest_reaches_no_install_surface(self):
        # Product L14133 (ov#416 S1): `"listed": false` skips a manifest BEFORE any check, so an app that is not
        # offered for install (and whose catalog text need not fit the install line) appears nowhere. Generic
        # fixture: a synthetic app whose 179-character description fails plain() exactly as an unflagged one does.
        committed_module = (REPO / 'plugins' / 'village-bridge' / '_install_catalog.py').read_text(encoding='utf-8')
        committed_skill = (REPO / 'skills' / 'mini-apps' / 'SKILL.md').read_text(encoding='utf-8')
        long_app = {'id': 'longapp', 'name': 'Long App', 'description': 'D' + 'x' * 178, 'version': '0.1.0',
                    'operations': ['mini-app.read']}
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            for app_id, doc in MANIFESTS.items():
                (root / app_id).mkdir(); (root / app_id / 'manifest.json').write_text(json.dumps(doc))
            (root / 'longapp').mkdir()
            manifest = root / 'longapp' / 'manifest.json'
            # Without the flag (or with listed: true) it is checked as today and refused: 179 > 160.
            for doc in (long_app, {**long_app, 'listed': True}):
                manifest.write_text(json.dumps(doc))
                with self.subTest(listed=doc.get('listed')), self.assertRaisesRegex(ValueError, 'description must be one line'):
                    gen.entries(root)
            # listed: false: skipped before any check, so the outputs are byte-identical to the committed ones.
            for doc in ({**long_app, 'listed': False}, {'listed': False, 'id': 'NOT VALID', 'name': '[x](https://evil.example)'}):
                manifest.write_text(json.dumps(doc))
                with self.subTest(unlisted=doc['id']):
                    apps = gen.entries(root)
                    self.assertEqual(apps, gen.entries())
                    self.assertEqual(gen.render(apps), committed_module)
                    self.assertEqual(gen.render_skill(apps, copy), committed_skill)
                    for text in (gen.render(apps), gen.render_skill(apps, copy)):
                        self.assertNotIn('longapp', text); self.assertNotIn('Long App', text); self.assertNotIn('evil.example', text)
            # Only a boolean false unlists; anything else is refused, never read as "unlisted".
            for value in ('false', 0, None, [], 'no'):
                manifest.write_text(json.dumps({**long_app, 'description': 'Short.', 'listed': value}))
                with self.subTest(listed=value), self.assertRaisesRegex(ValueError, 'listed must be false or absent'):
                    gen.entries(root)
        # At runtime nothing unlisted is in the catalog, so the cp naming it gives no link and no installable entry.
        self.assertNotIn('longapp', [a['id'] for a in catalog.INSTALLABLE + catalog.STAFF])
        self.assertEqual([a['id'] for a in link.offered({'AV_MINI_APPS_OFFERED': 'forkicks,longapp'})], ['forkicks'])
        self.offer('forkicks,longapp')
        self.nothing_installed()
        out = link.not_installed(Path(self.tmp.name), 'longapp', bridge.HANDLING)
        self.assertEqual(out['instruction'], copy.NOT_OFFERED); self.assertNotIn('installUrl', out)
        self.assertEqual([a['id'] for a in out['installable']], ['forkicks'])
        self.assertNotIn('longapp', json.dumps(out))

    def test_post_approval_rechecks_carry_the_link_too(self):
        self.offer(ALL)
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'gold-stars', **mini.GOLD_STARS}]}))
        refusal = link.not_installed(Path(self.tmp.name), 'forkicks', bridge.HANDLING)
        self.assertEqual(refusal['installUrl'], PAGE + 'forkicks')
        source = (REPO / 'plugins' / 'village-bridge' / '__init__.py').read_text(encoding='utf-8')
        self.assertNotIn('{"error": "mini_app_not_installed"}', source)
        self.assertEqual(source.count('not_installed(home, '), 3)

    def test_install_words_never_send_the_resident_to_the_team(self):
        skills = {name: (REPO / 'skills' / name / 'SKILL.md').read_text(encoding='utf-8') for name in ('mini-apps', 'rolodex', 'gold-stars', 'zzzbot')}
        texts = {'SCHEMA description': bridge.SCHEMA['description'], **{'skills/' + k: v for k, v in skills.items()},
                 **{'copy.' + k: v for k, v in vars(copy).items() if k.isupper() and isinstance(v, str)}}
        for where, text in texts.items():
            with self.subTest(where=where):
                self.assertEqual(team_referrals(text), [])
                for phrase in ('contact the agent village team', 'ask the agent village team', 'ask the edge city', 'contact the edge city', 'ask the organisers', 'ask the organizers'):
                    self.assertNotIn(phrase, text.lower())
        # The checker itself catches the screenshot's wording.
        self.assertTrue(team_referrals("I can't install it. Please ask the Agent Village team or the Edge City organisers."))
        # The lead's sentence is the tool description's install rule, written literally (R-DEON literal-evals SCHEMA).
        self.assertTrue(bridge.SCHEMA['description'].endswith(' ' + copy.TOOL_RULE))
        self.assertIn("If an app isn't installed, send the resident its install link (one tap).", copy.TOOL_RULE)
        self.assertIn("You cannot install apps yourself.", copy.TOOL_RULE)
        self.assertEqual(copy.RULE, copy.TOOL_RULE[:-1] + "; the resident's tap is the consent.")
        self.assertLessEqual(len(copy.TOOL_RULE), 160)  # tool_search findability budget (see _install_copy.py)
        self.assertIn('`installUrl`', skills['zzzbot'])
        for name in ('rolodex', 'gold-stars', 'zzzbot'):
            self.assertIn('`mini-apps`', skills[name])
        for name in ('rolodex', 'gold-stars'):  # Gold Stars comes with every agent: its words, never a link
            self.assertIn('never give an install link', skills[name]); self.assertIn("`instruction` words", skills[name])
            # review-b S3: nothing in them still says Gold Stars is optional or the owner must install it.
            flat = ' '.join(skills[name].split()).lower()
            for phrase in ('optional curated mini-app', 'optional **gold stars**', 'must install gold stars', 'or gold stars is not installed'):
                self.assertNotIn(phrase, flat)
            self.assertIn('every agent', flat)
        self.assertIn(copy.RULE, skills['mini-apps'])
        # v2.1.5 is on every box (lead L13755, product L13758): no install word asks for /new any more.
        for where, text in texts.items():
            with self.subTest(no_new=where):
                self.assertNotIn('/new', text)
        # Product's post-v2.1.5 tails, verbatim (CLAIMS L13415, L14006).
        self.assertTrue(copy.NAMED.endswith("{link} Once it's installed I'll pick it up on your next message."))
        self.assertEqual(copy.GENERAL_OUTRO, "Tap the ones you want; I'll pick each one up on your next message.")
        self.assertTrue(copy.MID_TASK.endswith("One tap: {link} Then ask me again."))
        self.assertTrue(copy.NOT_INSTALLED.endswith("give the one-tap link below. Never show this code."))
        self.assertTrue(copy.NEVER.endswith(" Never promise it works before their next message."))

    def test_the_installable_list_is_generated_from_the_catalog(self):
        # The committed module and skill are exactly the generator's output from the manifests and product's words.
        self.assertEqual(subprocess.run([sys.executable, '-I', str(GENERATOR), '--check'], capture_output=True).returncode, 0)
        self.assertEqual((list(catalog.INSTALLABLE), list(catalog.STAFF)), gen.split(gen.entries()))
        self.assertEqual([a['id'] for a in catalog.INSTALLABLE], sorted(INSTALLABLE_IDS))
        for app in catalog.INSTALLABLE:
            m = MANIFESTS[app['id']]
            self.assertEqual(app, {'id': m['id'], 'name': m['name'], 'description': m['description'], 'installUrl': PAGE + m['id']})
        for app in catalog.STAFF:
            m = MANIFESTS[app['id']]
            self.assertEqual(app, {'id': m['id'], 'name': m['name'], 'description': m['description']})
        skill = (REPO / 'skills' / 'mini-apps' / 'SKILL.md').read_text(encoding='utf-8')
        listed = skill.split('## Installable apps', 1)[1]
        self.assertEqual(re.findall(r'^- \*\*(.+?)\*\* — ', listed, re.M), [a['name'] for a in catalog.INSTALLABLE])
        for app in catalog.INSTALLABLE:
            self.assertIn('- ' + copy.LINE.format(name=app['name'], description=app['description'], link=app['installUrl']), listed)
        # A changed catalog changes the list: add an app and drop one in a scratch catalog.
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            for app_id, doc in MANIFESTS.items():
                if app_id != 'dizko':
                    (root / app_id).mkdir(); (root / app_id / 'manifest.json').write_text(json.dumps(doc))
            (root / 'newapp').mkdir()
            (root / 'newapp' / 'manifest.json').write_text(json.dumps({'id': 'newapp', 'name': 'New App', 'description': 'Does one new thing.'}))
            apps = gen.entries(root)
            self.assertEqual([a['id'] for a in apps], sorted((set(MANIFESTS) - {'dizko'}) | {'newapp'}))
            self.assertEqual([a['id'] for a in gen.split(apps)[1]], STAFF_IDS)
            self.assertIn('**New App** — Does one new thing. ' + PAGE + 'newapp', gen.render_skill(apps, copy))
            self.assertNotIn('Dizko', gen.render_skill(apps, copy).split('## Installable apps', 1)[1])
            # Marking an app staff moves it out of the installable list and drops its link; anything but true refuses.
            (root / 'newapp' / 'manifest.json').write_text(json.dumps({'id': 'newapp', 'name': 'New App', 'description': 'Does one new thing.', 'staff': True}))
            installable, staff = gen.split(gen.entries(root))
            self.assertIn({'id': 'newapp', 'name': 'New App', 'description': 'Does one new thing.'}, staff)
            self.assertNotIn('newapp', [a['id'] for a in installable])
            self.assertNotIn(PAGE + 'newapp', gen.render_skill(gen.entries(root), copy) + gen.render(gen.entries(root)))
            for value in ('true', 1, None, [], 'yes'):
                (root / 'newapp' / 'manifest.json').write_text(json.dumps({'id': 'newapp', 'name': 'New App', 'description': 'x', 'staff': value}))
                with self.subTest(staff=value), self.assertRaises(ValueError):
                    gen.entries(root)
            # A manifest cannot smuggle a link, markup or a mismatched id into the agent's words.
            for bad in ({'id': 'newapp', 'name': 'New App', 'description': 'See https://evil.example now.'},
                        {'id': 'newapp', 'name': '[New](https://evil.example)', 'description': 'x'},
                        {'id': 'other', 'name': 'New App', 'description': 'x'},
                        {'id': 'newapp', 'name': 'New App', 'description': 'line one\nline two'}):
                (root / 'newapp' / 'manifest.json').write_text(json.dumps(bad))
                with self.subTest(bad=bad), self.assertRaises(ValueError):
                    gen.entries(root)
        # The skill ships to every box.
        paths = (REPO / 'install' / 'paths.ts').read_text(encoding='utf-8')
        shipped = paths.split('export const EDGE_SKILL_NAMES = [', 1)[1].split('] as const;', 1)[0]
        self.assertIn('"mini-apps"', shipped)


if __name__ == '__main__':
    unittest.main()
