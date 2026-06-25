import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "search_forum.py"
SPEC = importlib.util.spec_from_file_location("search_forum", SCRIPT)
search_forum = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["search_forum"] = search_forum
SPEC.loader.exec_module(search_forum)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, _size=-1):
        return json.dumps(self.payload).encode("utf-8")


class SearchForumTests(unittest.TestCase):
    def test_missing_config_self_silences(self):
        old_url = os.environ.pop("EDGE_AGENT_CONTROL_PLANE_URL", None)
        old_token = os.environ.pop("ADMIN_TOKEN", None)
        try:
            result = search_forum.search_forum("memory after dinner", 5)
        finally:
            if old_url is not None:
                os.environ["EDGE_AGENT_CONTROL_PLANE_URL"] = old_url
            if old_token is not None:
                os.environ["ADMIN_TOKEN"] = old_token

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["reason"], "missing_control_plane_url")

    def test_posts_bounded_query_to_control_plane(self):
        old_url = os.environ.get("EDGE_AGENT_CONTROL_PLANE_URL")
        old_token = os.environ.get("ADMIN_TOKEN")
        os.environ["EDGE_AGENT_CONTROL_PLANE_URL"] = "https://control.example/"
        os.environ["ADMIN_TOKEN"] = "secret-admin-token"
        captured = {}

        def fake_urlopen(req, timeout):
            captured["url"] = req.full_url
            captured["timeout"] = timeout
            captured["headers"] = dict(req.header_items())
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse({
                "queryHash": "abc123",
                "results": [
                    {"title": "Memory", "snippet": "Dinner memory", "url": "https://forum.example/t/1"}
                ],
            })

        original = search_forum.urllib.request.urlopen
        try:
            search_forum.urllib.request.urlopen = fake_urlopen
            result = search_forum.search_forum("  memory   after dinner ", 20, timeout=2.5)
        finally:
            search_forum.urllib.request.urlopen = original
            if old_url is None:
                os.environ.pop("EDGE_AGENT_CONTROL_PLANE_URL", None)
            else:
                os.environ["EDGE_AGENT_CONTROL_PLANE_URL"] = old_url
            if old_token is None:
                os.environ.pop("ADMIN_TOKEN", None)
            else:
                os.environ["ADMIN_TOKEN"] = old_token

        self.assertEqual(captured["url"], "https://control.example/community/forum/search")
        self.assertEqual(captured["timeout"], 2.5)
        self.assertEqual(captured["headers"]["Authorization"], "Bearer secret-admin-token")
        self.assertEqual(captured["body"], {"query": "memory after dinner", "limit": 8})
        self.assertEqual(result["ok"], True)
        self.assertIsNone(result["surface"])
        self.assertEqual(result["queryHash"], "abc123")
        self.assertEqual(len(result["results"]), 1)

    def test_posts_surface_to_control_plane(self):
        old_url = os.environ.get("EDGE_AGENT_CONTROL_PLANE_URL")
        old_token = os.environ.get("ADMIN_TOKEN")
        os.environ["EDGE_AGENT_CONTROL_PLANE_URL"] = "https://control.example/"
        os.environ["ADMIN_TOKEN"] = "secret-admin-token"
        captured = {}

        def fake_urlopen(req, timeout):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResponse({
                "queryHash": "abc123",
                "filters": {"surfaces": ["simocracy_proposals"]},
                "results": [
                    {
                        "title": "Simocracy proposal: Zine table",
                        "sourceWorld": "Simocracy proposal",
                        "contentKind": "proposal",
                    }
                ],
            })

        original = search_forum.urllib.request.urlopen
        try:
            search_forum.urllib.request.urlopen = fake_urlopen
            result = search_forum.search_forum("zine table", 3, "simocracy-proposals", timeout=2.5)
        finally:
            search_forum.urllib.request.urlopen = original
            if old_url is None:
                os.environ.pop("EDGE_AGENT_CONTROL_PLANE_URL", None)
            else:
                os.environ["EDGE_AGENT_CONTROL_PLANE_URL"] = old_url
            if old_token is None:
                os.environ.pop("ADMIN_TOKEN", None)
            else:
                os.environ["ADMIN_TOKEN"] = old_token

        self.assertEqual(captured["body"], {
            "query": "zine table",
            "limit": 3,
            "surface": "simocracy_proposals",
        })
        self.assertEqual(result["surface"], "simocracy_proposals")
        self.assertEqual(result["filters"], {"surfaces": ["simocracy_proposals"]})
        self.assertEqual(result["results"][0]["sourceWorld"], "Simocracy proposal")

    def test_rejects_empty_and_oversized_query(self):
        with self.assertRaises(ValueError):
            search_forum.normalize_query("")
        with self.assertRaises(ValueError):
            search_forum.normalize_query("x" * (search_forum.MAX_QUERY_CHARS + 1))
        with self.assertRaises(ValueError):
            search_forum.normalize_surface("private_messages")


if __name__ == "__main__":
    unittest.main()
