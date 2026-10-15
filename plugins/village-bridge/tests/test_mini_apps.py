"""Offline authority/boundary regressions; no Hermes, daemon, model or network."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("mini_apps_test", Path(__file__).parents[1] / "_mini_apps.py")
mini = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mini)


def answer(doc=None, code=0):
    doc = doc or {}
    return types.SimpleNamespace(ok=code == 0 and doc.get("ok") is True, doc=doc, exit_code=code, status=doc.get("status"))


class ApprovalTest(unittest.TestCase):
    def setUp(self):
        self.draft = "550e8400-e29b-41d4-a716-446655440000"
        self.preview = dict(appId="gold-stars", draftId=self.draft, attendeeId=self.draft,
                            recipientName="Naman", note="Exact note: café", visibility="anonymous")
        self.ap = Mock()
        self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task="propose:" + "a" * 32, decision="requested", state="granted", payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
        self.ap.wait.return_value = answer(dict(status="granted"))
        self.ap.start.return_value = answer(dict(ok=True, authorization="grant"))
        p = patch.object(mini, "approval_modules", return_value=self.ap)
        p.start()
        self.addCleanup(p.stop)

    def test_exact_preview_passed_to_propose_and_start(self):
        grant, refusal = mini.authorize_send(self.preview, self.draft)
        self.assertIsNone(refusal)
        args = self.ap.propose.call_args.args
        self.assertEqual(args[0], "marketplace.app.action")
        self.assertEqual(json.loads(args[3]), grant["payload"])
        self.assertEqual(grant["payload"]["preview"], self.preview)
        self.assertEqual(self.ap.start.call_args.args, ("propose:" + "a" * 32, args[1], args[3]))
        self.ap.wait.assert_called_once_with("propose:" + "a" * 32)

    def test_malformed_daemon_task_ids_never_reach_wait_or_start(self):
        for task in ("propose:123", "a" * 32, self.draft, "propose:" + "A" * 32, "propose:" + "a" * 32 + "\n"):
            self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task=task, decision="requested", state="granted", payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
            self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_refused")
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()

    def test_pending_rejected_revoked_expired_never_start(self):
        for status in ("requested", "rejected", "revoked", "expired", "executed", "void"):
            self.ap.wait.return_value = answer(dict(status=status), 7)
            grant, refusal = mini.authorize_send(self.preview, self.draft)
            self.assertIsNone(grant)
            self.assertEqual(refusal["error"], "approval_required")
        self.ap.start.assert_not_called()

    def test_policy_autonomy_cannot_replace_manual_grant(self):
        self.ap.propose.return_value = None
        self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task="propose:" + "a" * 32, decision="autonomous", payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
        self.assertIsNone(mini.authorize_send(self.preview, self.draft)[0])
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()

    def test_changed_payload_hash_refused(self):
        self.ap.propose.side_effect = lambda *args: answer(dict(ok=True, task="propose:" + "a" * 32, decision="requested", payload_hash="wrong"))
        self.assertIsNone(mini.authorize_send(self.preview, self.draft)[0])
        self.ap.start.assert_not_called()

    def test_wrong_start_authorization_refused(self):
        self.ap.start.return_value = answer(dict(ok=True, authorization="policy"))
        self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_not_started")

    def test_executed_proposal_reconstructs_identical_proof_without_another_start(self):
        original, refusal = mini.authorize_send(self.preview, self.draft)
        self.assertIsNone(refusal)
        proposed = self.ap.propose.call_args
        self.ap.wait.reset_mock()
        self.ap.start.reset_mock()
        self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task="propose:" + "a" * 32, decision="requested", state="executed", payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
        replay, refusal = mini.authorize_send(self.preview, self.draft)
        self.assertIsNone(refusal)
        self.assertEqual(replay, original)
        self.assertEqual(self.ap.propose.call_args, proposed)
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()

    def test_executed_proposal_with_mismatched_hash_cannot_replay(self):
        self.ap.propose.side_effect = lambda *args: answer(dict(ok=True, task="propose:" + "a" * 32, decision="requested", state="executed", payload_hash="wrong"))
        self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_refused")
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()

    def test_preview_from_another_draft_and_extra_model_flags_refused(self):
        for preview in ({**self.preview, "draftId": "other"}, {**self.preview, "approved": True}, None):
            self.assertIsNone(mini.authorize_send(preview, self.draft)[0])
        self.ap.propose.assert_not_called()


class ProjectionTest(unittest.TestCase):
    def test_only_exact_reviewed_projection_and_no_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "mini-apps.json"
            app = {"id": "gold-stars", **mini.GOLD_STARS}
            doc = {"version": 1, "apps": [app]}
            path.write_text(json.dumps(doc))
            self.assertTrue(mini.installed(home, "gold-stars", "gold-stars.send"))
            # BRIDGE-RESTORE: the reviewed entry carries ov#300's two native operations.
            self.assertTrue(mini.installed(home, "gold-stars", "rolodex.meeting"))
            self.assertTrue(mini.installed(home, "gold-stars", "skylight.status"))
            self.assertFalse(mini.installed(home, "dizko", "mini-app.read"))
            self.assertFalse(mini.installed(home, "dizko", "rolodex.meeting"))
            # The pre-restore entry stays valid for its own six operations only.
            previous = {"id": "gold-stars", **mini.GOLD_STARS_PREVIOUS}
            path.write_text(json.dumps({"version": 1, "apps": [previous]}))
            self.assertTrue(mini.installed(home, "gold-stars", "gold-stars.send"))
            self.assertFalse(mini.installed(home, "gold-stars", "rolodex.meeting"))
            self.assertFalse(mini.installed(home, "gold-stars", "skylight.status"))
            ops = app["operations"]
            for apps in ([{**app, "operations": ops + ["rolodex.delete"]}], [{**app, "operations": [o for o in ops if o != "skylight.status"]}],
                         [{**app, "operations": ops[::-1]}], [{**previous, "operations": previous["operations"] + ["rolodex.meeting"]}],
                         [{**app, "skills": ["gold-stars", "rolodex"]}], [app, previous], [app, app], [], [{**app, "version": "future"}]):
                path.write_text(json.dumps({"version": 1, "apps": apps}))
                self.assertFalse(mini.installed(home, "gold-stars", "gold-stars.send"))
            path.unlink()
            other = home / "other.json"
            other.write_text(json.dumps(doc))
            path.symlink_to(other)
            self.assertFalse(mini.installed(home, "gold-stars", "gold-stars.send"))

    def test_rolodex_person_entries_9_8_6_each_carry_their_own_operations(self):
        # ROLODEX.PERSON (rc42): the 9-op entry appends rolodex.person LAST; the 8-op (ov#350, the CP's
        # current entry) and 6-op (ov#343) entries stay accepted, each for exactly its own operations.
        nine = mini.GOLD_STARS["operations"]
        eight = mini.GOLD_STARS_RESTORED["operations"]
        six = mini.GOLD_STARS_PREVIOUS["operations"]
        self.assertEqual(nine, eight + ["rolodex.person"])
        self.assertEqual(eight, six + ["rolodex.meeting", "skylight.status"])
        self.assertEqual(mini.GOLD_STARS_ACCEPTED, (mini.GOLD_STARS, mini.GOLD_STARS_RESTORED, mini.GOLD_STARS_PREVIOUS))
        for entry in mini.GOLD_STARS_ACCEPTED:
            self.assertEqual((entry["version"], entry["skills"]), ("1.1.0", ["gold-stars"]))
        everything = sorted(mini.READ_OPERATIONS | mini.WRITE_OPERATIONS - {"mini-app.read"})
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "mini-apps.json"
            for entry in mini.GOLD_STARS_ACCEPTED:
                path.write_text(json.dumps({"version": 1, "apps": [{"id": "gold-stars", **entry}]}))
                for op in everything:
                    with self.subTest(ops=len(entry["operations"]), op=op):
                        self.assertEqual(mini.installed(home, "gold-stars", op), op in entry["operations"])
            app = {"id": "gold-stars", **mini.GOLD_STARS}
            restored = {"id": "gold-stars", **mini.GOLD_STARS_RESTORED}
            previous = {"id": "gold-stars", **mini.GOLD_STARS_PREVIOUS}
            refused = (
                [{**app, "operations": ["rolodex.person"] + eight}],  # not appended last
                [{**app, "operations": eight[:6] + ["rolodex.person"] + eight[6:]}],
                [{**previous, "operations": six + ["rolodex.person"]}],  # person without the restore
                [{**app, "operations": nine + ["rolodex.person"]}],
                [{**app, "operations": nine + ["rolodex.profile"]}],
                [{**app, "version": "1.2.0"}], [app, restored], [restored, previous], [app, previous],
            )
            for apps in refused:
                path.write_text(json.dumps({"version": 1, "apps": apps}))
                with self.subTest(apps=apps):
                    self.assertFalse(mini.installed(home, "gold-stars", "rolodex.person"))
                    self.assertFalse(mini.installed(home, "gold-stars", "rolodex.search"))

    def test_rolodex_person_is_a_read(self):
        self.assertIn("rolodex.person", mini.READ_OPERATIONS)
        self.assertNotIn("rolodex.person", mini.WRITE_OPERATIONS)
        self.assertFalse(mini.READ_OPERATIONS & mini.WRITE_OPERATIONS)

    def test_disabled_missing_and_unverified_authority_refused(self):
        for configured, switch, codes in ((False, "on", ()), (True, "off", ()), (True, "on", ("hook-missing:village",))):
            ap = types.SimpleNamespace(configured=lambda: configured)
            gate = types.SimpleNamespace(switch=lambda: switch, current_codes=lambda: codes)
            with patch.object(mini.importlib, "import_module", side_effect=[ap, gate]):
                with self.assertRaises(ValueError):
                    mini.approval_modules()


if __name__ == "__main__":
    unittest.main()
