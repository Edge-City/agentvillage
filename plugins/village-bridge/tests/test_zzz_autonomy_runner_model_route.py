"""RUNNER-MODEL-RESOLVE: under provider auto (or none), the autonomy runner takes the OpenRouter key from config.yaml's
own model.api_key when .env holds none, as Hermes does.

Canary aa9a5de3 (v2.1.22, lead CLAIMS L32121): .env has no OPENROUTER_API_KEY; config.yaml's model block is provider
auto, default anthropic/claude-haiku-5.5, base_url https://openrouter.ai/api/v1 and an api_key. The v2.1.22 runner
(e6edc00f) required the key in .env before it reached its own config api_key fallback, so every tick stopped at
`model_route ValueError model-provider`. Everything else answers exactly as v2.1.22 did (a differential against those
bytes, kept as the installer's upgrade fixture).
"""
import importlib.machinery
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TESTS = Path(__file__).parent
SCRIPT = TESTS.parents[2] / "skills/zzzbot/scripts/zzz_autonomy_runner.py"
OLD_BYTES = TESTS.parents[2] / "install/tests/fixtures/zzz_autonomy_runner.v2122.py.fixture"
FIXTURES = TESTS / "fixtures" / "zzz_runner_config"
OPENROUTER = "https://openrouter.ai/api/v1"
CONFIG_KEY = "fixture-config-openrouter-key"


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


runner = load("zzz_autonomy_runner_model_route_new", SCRIPT)
old = load("zzz_autonomy_runner_model_route_v2122", OLD_BYTES)
corpus = load("zzz_autonomy_runner_model_route_corpus", TESTS / "test_zzz_autonomy_runner_stdlib.py")
try:
    import yaml  # noqa: F401  (test-only: both read paths are exercised when it is importable)
except ImportError:  # pragma: no cover - CI installs pyyaml
    yaml = None

CANARY = (
    "model:\n"
    "  default: anthropic/claude-haiku-5.5\n"
    "  provider: auto\n"
    "  base_url: https://openrouter.ai/api/v1\n"
    f"  api_key: {CONFIG_KEY}\n"
    "fallback_providers:\n"
    "  - provider: openrouter\n"
    "    model: openai/gpt-6-luna\n"
)
# .env as boxes hold it: none, the canary's (no provider key at all), each key, an empty or a duplicated key.
ENVS = {
    "absent": None,
    "canary": "HERMES_MODEL=anthropic/claude-haiku-5.5\nAV_RECALL_ENABLED=1\n",
    "openrouter": "OPENROUTER_API_KEY=fixture-openrouter\n",
    "openai": "OPENAI_API_KEY=fixture-openai\n",
    "both": "OPENROUTER_API_KEY=fixture-openrouter\nOPENAI_API_KEY=fixture-openai\n",
    "empty-openrouter": "OPENROUTER_API_KEY=\n",
    "duplicate-openrouter": "OPENROUTER_API_KEY=a\nOPENROUTER_API_KEY=b\n",
}


def read_paths():
    """Each config.yaml read path: the stdlib fallback (PyYAML blocked) and, where importable, yaml.safe_load."""
    return (True, False) if yaml else (True,)


class Box:
    def __init__(self, test):
        temp = tempfile.TemporaryDirectory()
        test.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()  # macOS /var is a symlink; the runner refuses linked parents

    def write(self, config, env):
        (self.home / "config.yaml").write_text(config)
        dotenv = self.home / ".env"
        if env is None:
            dotenv.unlink(missing_ok=True)
        else:
            dotenv.write_text(env)
        return self.home


def outcome(module, home):
    try:
        return "route", module._model_route(home)
    except Exception as error:  # noqa: BLE001 - the answer is the class and the code
        return type(error).__name__, str(error)


class TestConfigKeyUnderAuto(unittest.TestCase):
    def route(self, config, env=None):
        home = Box(self).write(config, env)
        answers = set()
        for blocked in read_paths():
            with patch.dict(sys.modules, {"yaml": None} if blocked else {}):
                answers.add(outcome(runner, home))
        self.assertEqual(len(answers), 1, answers)
        return answers.pop()

    def test_the_canary_shape_routes_to_openrouter_with_the_config_key(self):
        expected = ("route", (OPENROUTER, CONFIG_KEY, "anthropic/claude-haiku-5.5"))
        for name in ("absent", "canary"):
            with self.subTest(env=name):
                self.assertEqual(self.route(CANARY, ENVS[name]), expected)
        # v2.1.22 refused this exact box.
        home = Box(self).write(CANARY, ENVS["canary"])
        self.assertEqual(outcome(old, home), ("ValueError", "model-provider"))

    def test_a_missing_or_empty_provider_reads_as_auto(self):
        for line in ("", "  provider: \n", "  provider: ''\n", "  provider: ~\n"):
            with self.subTest(line=line):
                config = CANARY.replace("  provider: auto\n", line)
                self.assertEqual(self.route(config, ENVS["canary"]),
                                 ("route", (OPENROUTER, CONFIG_KEY, "anthropic/claude-haiku-5.5")))

    def test_an_empty_base_url_does_not_send_the_config_key_to_openrouter(self):
        # review-b ov#553 S1: with no base_url nothing shows the config key is an OpenRouter key; v2.1.22's answer stands.
        for line in ("", "  base_url: ''\n"):
            with self.subTest(line=line):
                config = CANARY.replace("  base_url: https://openrouter.ai/api/v1\n", line)
                self.assertEqual(self.route(config, ENVS["canary"]), ("ValueError", "model-provider"))
                # An .env OpenRouter key still routes it, as v2.1.22 did.
                self.assertEqual(self.route(config, ENVS["openrouter"])[0], "route")

    def test_a_dotenv_key_still_wins_over_the_config_key(self):
        self.assertEqual(self.route(CANARY, ENVS["openrouter"]),
                         ("route", (OPENROUTER, "fixture-openrouter", "anthropic/claude-haiku-5.5")))

    def test_a_bare_model_name_still_refuses(self):
        config = CANARY.replace("anthropic/claude-haiku-5.5", "claude-haiku-5.5", 1)
        self.assertEqual(self.route(config, ENVS["canary"]), ("ValueError", "model-provider"))

    def test_a_base_url_for_another_host_still_refuses(self):
        for url in ("https://api.openai.com/v1", "http://localhost:11434/v1", "https://openrouter.ai/api/v1/",
                    "https://evil.example/api/v1"):
            with self.subTest(url=url):
                config = CANARY.replace(OPENROUTER, url)
                # S1: the config key counts only with OpenRouter's own base_url, so this refuses one step earlier,
                # exactly as v2.1.22 did (model-provider); with an .env OpenRouter key it still stops at model-route.
                self.assertEqual(self.route(config, ENVS["canary"]), ("ValueError", "model-provider"))
                self.assertEqual(self.route(config, ENVS["openrouter"]), ("ValueError", "model-route"))

    def test_another_api_mode_still_refuses(self):
        config = CANARY.replace("  provider: auto\n", "  provider: auto\n  api_mode: anthropic_messages\n")
        self.assertEqual(self.route(config, ENVS["canary"]), ("ValueError", "model-route"))

    def test_neither_key_refuses_model_provider(self):
        for line in ("", "  api_key: ''\n", "  api_key: ~\n", "  api_key: 'has space'\n", "  api_key: \"tab\\tkey\"\n",
                     f"  api_key: '{'k' * 4097}'\n"):
            with self.subTest(line=line[:40]):
                config = CANARY.replace(f"  api_key: {CONFIG_KEY}\n", line)
                for name in ("absent", "canary", "openai", "empty-openrouter"):
                    with self.subTest(env=name):
                        self.assertEqual(self.route(config, ENVS[name]), ("ValueError", "model-provider"))

    def test_a_typed_config_key_is_not_a_key(self):
        # PyYAML reads `api_key: 12345` as an int; the stdlib fallback refuses a typed kept value outright.
        config = CANARY.replace(f"  api_key: {CONFIG_KEY}\n", "  api_key: 12345\n")
        home = Box(self).write(config, ENVS["canary"])
        with patch.dict(sys.modules, {"yaml": None}):
            self.assertEqual(outcome(runner, home), ("ValueError", "model-config"))
        if yaml:
            self.assertEqual(outcome(runner, home), ("ValueError", "model-provider"))

    def test_the_explicit_provider_path_is_unchanged(self):
        # An explicit provider never needed the .env key to pass the provider step; that path is the old one.
        for provider, expected in (("openrouter", ("route", (OPENROUTER, CONFIG_KEY, "anthropic/claude-haiku-5.5"))),
                                   ("anthropic", ("ValueError", "model-provider")),
                                   ("custom", ("ValueError", "model-provider"))):
            with self.subTest(provider=provider):
                config = CANARY.replace("provider: auto", f"provider: {provider}", 1)
                self.assertEqual(self.route(config, ENVS["canary"]), expected)
                self.assertEqual(outcome(old, Box(self).write(config, ENVS["canary"])), expected)


class TestDifferentialAgainstV2122(unittest.TestCase):
    """New == v2.1.22 everywhere, except the one widened case: provider none/empty/auto, a slash model, base_url exactly
    OpenRouter's endpoint, no usable OPENROUTER_API_KEY in .env and a usable config api_key, which v2.1.22 refused as model-provider and which now
    takes the route (or the base_url/api_mode/key check that follows, exactly as an .env key would)."""

    @staticmethod
    def widened(home, old_answer):
        if old_answer != ("ValueError", "model-provider"):
            return False
        model = runner._model_section((home / "config.yaml").read_bytes())
        return (isinstance(model, dict) and model.get("provider") in (None, "", "auto")
                and isinstance(model.get("default"), str) and "/" in model["default"]
                and model.get("base_url") == runner.ENDPOINTS["openrouter"][0]
                and not runner._key(home, "OPENROUTER_API_KEY") and runner._usable_key(model.get("api_key")))

    def compare(self, texts):
        box = Box(self)
        counts = {"equal": 0, "widened": 0}
        for text in texts:
            for env in ENVS.values():
                home = box.write(text, env)
                for blocked in read_paths():
                    with patch.dict(sys.modules, {"yaml": None} if blocked else {}):
                        before, after = outcome(old, home), outcome(runner, home)
                        if before == after:
                            counts["equal"] += 1
                            continue
                        self.assertTrue(self.widened(home, before), (text, env, before, after))
                        self.assertNotEqual(after, ("ValueError", "model-provider"), text)
                        counts["widened"] += 1
        return counts

    def test_every_writer_fixture_answers_as_v2122(self):
        texts = [path.read_text(encoding="utf-8") for path in sorted(FIXTURES.glob("*.yaml"))]
        self.assertGreaterEqual(len(texts), 15)
        self.assertEqual(self.compare(texts)["widened"], 0)

    def test_generated_configs_answer_as_v2122_but_for_the_widened_case(self):
        texts = [*corpus.generated(20261029, 400, False), *corpus.generated(31, 400, True), CANARY]
        counts = self.compare(texts)
        self.assertGreater(counts["widened"], 0)
        self.assertGreater(counts["equal"], counts["widened"])


if __name__ == "__main__":
    unittest.main()
