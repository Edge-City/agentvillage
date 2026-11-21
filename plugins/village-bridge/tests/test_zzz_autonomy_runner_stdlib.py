"""RUNNER-STDLIB-ROUTE: the autonomy runner reads config.yaml's `model` block without PyYAML, imports nothing outside
the standard library before its claim, and names the failing step on stderr.

The fixtures in fixtures/zzz_runner_config/ are real writer output, not hand-written YAML:
- hermes-*.yaml: Hermes v2026.9.24's one config.yaml writer (utils.atomic_roundtrip_yaml_save, ruamel.yaml 0.18.17,
  with save_config's commented sections on create), for the shapes Hermes and the cp write (`hermes config set
  model.default/model.provider`, the ODIN model PUT's base_url + context_length, openai direct, an inline key, a bare
  `model` string, YAML 1.1 words it double-quotes, nested ignored keys, a hand-edited file it round-trips).
- installer-*.yaml: the overlay installer's one writer (install/config.ts dumpConfig, the `yaml` package), including a
  long string it folds over several lines.
"""
import importlib.util
import json
import logging
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
import venv
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).parents[3] / "skills/zzzbot/scripts/zzz_autonomy_runner.py"
SPEC = importlib.util.spec_from_file_location("zzz_autonomy_runner_stdlib_test", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
FIXTURES = Path(__file__).parent / "fixtures" / "zzz_runner_config"
TOKEN = "avb_" + "a" * 43
REFUSED = "REFUSED"
try:
    import yaml  # test-only: the differential reference
except ImportError:  # pragma: no cover - CI installs pyyaml
    yaml = None


def kept(model):
    """What _model_route can see of yaml.safe_load's `model`: the kept keys of a mapping, any other value as is."""
    return {key: value for key, value in model.items() if key in runner.MODEL_KEYS} if isinstance(model, dict) else model


def read(text: str):
    try:
        return runner._model_config(text.encode())
    except ValueError as error:
        assert str(error) == "model-config", error
        return REFUSED


def pyyaml(text: str):
    """(True, kept model) when yaml.safe_load reads the text, else (False, None)."""
    try:
        doc = yaml.safe_load(text)
    except Exception:
        return False, None
    return True, kept(doc.get("model")) if isinstance(doc, dict) else None


# ---- the differential corpus ---------------------------------------------------------------------------------------
TEXT = ["openrouter", "openai", "openai-api", "auto", "anthropic/claude-haiku-4.5", "https://openrouter.ai/api/v1",
        "chat_completions", "01-ai/yi-large", "meta-llama/llama-3:free", "x-ai/grok-4", "a#b", "a:b", "-x", "?x", ":x",
        "a [b] {c},d", "~x", "nullx", "Yes!", "fixture-key-" + "f" * 64, "é ☕", "1a", "0x", "2026-10", "y", "n"]
QUOTED = ["''", '""', "'it''s'", '"a\\"b"', '"\\x41\\u00e9\\U0001F600"', '"tab\\there"', "'a: b #c'", '"null"', "'yes'",
          '"\\/"', "'0o17'", '" lead"', "'#'", '"\\\\"', '"\\N\\_\\L"', "'x'  # c", "'\\n'"]
TYPED = ["yes", "No", "on", "OFF", "true", "FALSE", "1", "017", "0o17", "0x1F", "1_000", "1.5", ".5", "1.0e+3", ".inf",
         "-.Inf", ".NaN", "1:20", "190:20:30.15", "2026-10-29", "2026-10-29 10:00:00", "2026-1-2T3:04:05Z", "0b101",
         "+12", "-0", "<<", "="]
NULLS = ["", "~", "null", "Null", "NULL", "# only a comment"]
JUNK = ["a: b", "a:", "- x", "*alias", "&anchor v", "!!str v", "!t v", "[a]", "[]", "{}", "{a: 1}", "[a, 'b]", "|",
        ">-", "|2", "'open", '"open', '"x" y', '"x"#c', "%x", "@x", "`x", ",x", "]x", '"\\q"', "a\tb", "12:"]
BEFORE = [[], ["# my box"], ["toolsets:", "  - hermes-cli"], ["toolsets:", "- a", "- b"],
          ["agent:", '  system_prompt: "long', '    folded: line"'], ["note: |", "  model: not this", "", "  text"],
          ["a: [1, 'two', {b: c}]"], ["q: 'it''s", "  multi'"], ["cron:", "  model: m"]]
AFTER = [[], ["display:", "  personality: kawaii"], ["fallback_providers: []"], ["cron:", "  model: m"],
         ["tail: >-", "  model: no"], ["z: {a: 1}"], ["custom_providers:", "  - name: x", "    api_key: k"]]
# Shapes that can hide, fake or bend the `model:` line or block (most of them PyYAML refuses outright).
HOSTILE_BEFORE = [["agent:", '  note: "open', 'model: x"'], ["agent:", "  note: 'it''s", "model: y'"], ["---"],
                  ["%YAML 1.1", "---"], ["a: [1,", "  2]"], ["<<:", "  model:", "    provider: m"], ["a: &x 1"],
                  ["\ufeffc: 1"], ["  indented: 1"], ["- top"], ['q: "multi', "", '  line"'], ["q: 'x' y"],
                  ['k: "esc\\', '  more"'], ["long: a", "  b c"], ["k:", '  "s', 'model: z"'], ["t: 1\t"]]
HOSTILE_AFTER = [["model:", "  provider: twice"], ["x: 1", "..."], ['z: "unterminated'], ["- stray"], ["\t"]]


def generated(seed: int, count: int, hostile: bool):
    """Seeded config.yaml texts around one model block: valid-biased, or mixed with junk and hostile shapes."""
    rng = random.Random(seed)
    for _ in range(count):
        indent = rng.choice(["  ", "    ", " "])
        pools = [TEXT, TEXT, QUOTED, TYPED, NULLS] + ([JUNK] if hostile else [])
        def value():
            pool = rng.choice(pools)
            text = rng.choice(pool)
            return text + rng.choice([" # tail", "  #x", "#x", ""]) if pool is TEXT and rng.random() < 0.2 else text
        lines = list(rng.choice(BEFORE + (HOSTILE_BEFORE if hostile else [])))
        if rng.random() < 0.15:
            lines.append(rng.choice(["model: ", "model:  ", '"model": ', "model:\t", "? model: "] if hostile else
                                    ["model: "]) + value())
        else:
            lines.append(rng.choice(["model:", "model:  # c", "model :"] + (["model: {}", "model: []"] if hostile else [])))
            keys = [*runner.MODEL_KEYS, "context_length", "extra_body", "max_tokens"]
            rng.shuffle(keys)
            for key in keys[:rng.randint(0, len(keys))]:
                if rng.random() < 0.1:
                    lines.append(rng.choice(["", "# c", indent + "# c", "#"]))
                if key == "extra_body" and rng.random() < 0.6:
                    lines += [indent + key + ":", indent * 2 + "reasoning:", indent * 3 + "effort: low",
                              indent * 2 + "order:", indent * 2 + "- a"]
                    continue
                separator = rng.choice([": ", ":  ", " : "] + ([":", ":\t"] if hostile else []))
                line = indent + key + separator + value()
                if hostile and rng.random() < 0.1:
                    line = rng.choice([indent * 2, "\t", indent[:-1] or indent]) + line.lstrip()
                lines.append(line)
                if hostile and rng.random() < 0.12:
                    lines.append(indent * 2 + rng.choice(["a: 1", "- x", "b: 'c'", 'c: "d', "deep", "provider: evil",
                                                          "|", "[1,", "d: {}"]))
            if rng.random() < 0.05:
                lines.append(indent + rng.choice(runner.MODEL_KEYS) + ": dup")
        lines += rng.choice(AFTER + (HOSTILE_AFTER if hostile else []))
        if hostile and rng.random() < 0.1:
            rng.shuffle(lines)
        yield "\n".join(lines) + rng.choice(["\n", "", "\r\n"] if hostile else ["\n"])


class TestModelConfigReader(unittest.TestCase):
    def fixtures(self):
        found = sorted(FIXTURES.glob("*.yaml"))
        self.assertGreaterEqual(len(found), 15)
        self.assertTrue(any(p.name.startswith("hermes-") for p in found))
        self.assertTrue(any(p.name.startswith("installer-") for p in found))
        return {path.stem: path.read_text(encoding="utf-8") for path in found}

    def test_writer_fixtures_read_as_expected_without_pyyaml(self):
        texts = self.fixtures()
        self.assertEqual(read(texts["hermes-odin-model-put"]), {
            "default": "anthropic/claude-opus-5.5", "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1"})
        self.assertEqual(read(texts["hermes-openai-direct"]), {
            "provider": "openai", "default": "gpt-5.4-mini", "base_url": "", "api_mode": "chat_completions", "api_key": ""})
        self.assertEqual(read(texts["hermes-ambiguous-words"]), {
            "provider": "openrouter", "default": "anthropic/claude-haiku-4.5", "api_mode": "off", "base_url": "null",
            "api_key": "yes"})
        self.assertEqual(read(texts["hermes-quoted-values"]), {
            "provider": "openrouter", "default": "123", "base_url": "a: b #c", "api_key": "'quoted'",
            "api_mode": " lead space"})
        self.assertEqual(read(texts["hermes-bare-model-string"]), "anthropic/claude-sonnet-4.6")
        self.assertEqual(read(texts["installer-quoting"]), {
            "default": "anthropic/claude-haiku-4.5", "provider": "openrouter", "base_url": "", "api_mode": "",
            "api_key": "0o755"})
        self.assertEqual(read(texts["installer-long-string-elsewhere"]),
                         {"default": "openai/gpt-5.4-mini", "provider": "openrouter"})
        for name, text in texts.items():
            with self.subTest(name):
                self.assertNotEqual(read(text), REFUSED)

    @unittest.skipUnless(yaml, "PyYAML is the differential reference")
    def test_writer_fixtures_read_exactly_as_pyyaml(self):
        for name, text in self.fixtures().items():
            with self.subTest(name):
                ok, expected = pyyaml(text)
                self.assertTrue(ok)
                self.assertEqual(read(text), expected)

    def test_ambiguous_shapes_are_refused(self):
        refused = {
            "flow mapping": "model: {provider: openrouter}\n",
            "flow on a kept key": "model:\n  provider: [openrouter]\n",
            "empty flow on a kept key": "model:\n  provider: {}\n",
            "flow on an ignored key": "model:\n  extra: {a: 1}\n",
            "anchor": "model:\n  provider: &p openrouter\n",
            "alias": "base: &p openrouter\nmodel:\n  provider: *p\n",
            "tag": "model:\n  provider: !!str openrouter\n",
            "merge key": "model:\n  <<: {provider: openrouter}\n",
            "top-level merge": "<<:\n  model:\n    provider: openrouter\n",
            "block scalar": "model:\n  default: |\n    anthropic/x\n",
            "folded scalar": "model:\n  default: >-\n    anthropic/x\n",
            "multi-line plain": "model:\n  default: anthropic/\n    claude\n",
            "multi-line double-quoted": 'model:\n  default: "anthropic/\n    claude"\n',
            "multi-line single-quoted": "model:\n  default: 'anthropic/\n    claude'\n",
            "value on the next line": "model:\n  default:\n    anthropic/x\n",
            "nested under a kept key": "model:\n  provider:\n    name: openrouter\n",
            "sequence under a kept key": "model:\n  provider:\n    - openrouter\n",
            "duplicate kept key": "model:\n  provider: openai\n  provider: openrouter\n",
            "duplicate ignored key": "model:\n  extra: 1\n  extra: 2\n",
            "model twice": "model:\n  provider: openai\nmodel:\n  provider: openrouter\n",
            "tab indentation": "model:\n\tprovider: openrouter\n",
            "tab in a value": "model:\n  provider:\topenrouter\n",
            "tab-only line": "model:\n  provider: openrouter\n\t\n",
            "typed kept value": "model:\n  default: 1.5\n",
            "boolean kept value": "model:\n  api_mode: off\n",
            "date kept value": "model:\n  default: 2026-10-29\n",
            "model is a sequence": "model:\n- a\n",
            "model is an indented sequence": "model:\n  - a\n",
            "quoted model key": '"model":\n  provider: openrouter\n',
            "explicit model key": "? model\n: x\n",
            "quoted kept key": 'model:\n  "provider": openrouter\n',
            "uneven indentation": "model:\n    provider: openrouter\n  default: x\n",
            "document marker": "---\nmodel:\n  provider: openrouter\n",
            "directive": "%YAML 1.1\n---\nmodel: x\n",
            "model line inside a string": 'agent:\n  note: "a\nmodel: x"\n',
            "unclosed string at the end": 'model: x\nnote: "a\n',
            "unclosed flow elsewhere": "a: [1,\n  2]\nmodel: x\n",
            "indented top level": "  model:\n    provider: openrouter\n",
            "a sequence at the top": "- model: x\n",
            "bad escape": 'model:\n  default: "\\q"\n',
            "junk after a quote": 'model:\n  default: "x" y\n',
            "colon in a plain value": "model:\n  default: a: b\n",
            "non-printable": "model:\n  default: a\x07b\n",
            "line separator": "model:\n  default: a\u2028b\n",
            "lone carriage return": "model:\r  default: x\n",
            "not utf-8": None,
        }
        for name, text in refused.items():
            with self.subTest(name):
                raw = b"model:\n  default: \xff\n" if text is None else text.encode()
                with self.assertRaisesRegex(ValueError, "^model-config$"):
                    runner._model_config(raw)

    def test_accepted_edge_cases(self):
        accepted = {
            "": None,
            "# only a comment\n": None,
            "model:\n": None,
            "model:\nother: 1\n": None,
            "model: ~\n": None,
            "model: {}\n": {},
            "model: []\n": [],
            "other: 1\n": None,
            "model: anthropic/x  # bare\n": "anthropic/x",
            "model : 'x'\n": "x",
            "\ufeffmodel:\r\n  provider: openrouter\r\n": {"provider": "openrouter"},
            "model:\n  provider: openrouter\n": {"provider": "openrouter"},
            "model:\n    provider: openrouter # c\n    default: a#b\n": {"provider": "openrouter", "default": "a#b"},
            "model:\n  provider:\n  default: ~\n  base_url: null\n  api_key: # none\n":
                {"provider": None, "default": None, "base_url": None, "api_key": None},
            "model:\n  default: 'it''s'\n  provider: \"a\\\"b\\u00e9\"\n": {"default": "it's", "provider": 'a"bé'},
            "model:\n  default: meta-llama/llama-3:free\n  base_url: https://x.example/v1\n":
                {"default": "meta-llama/llama-3:free", "base_url": "https://x.example/v1"},
            "model:\n  default: 01-ai/yi-large\n  provider: -x\n": {"default": "01-ai/yi-large", "provider": "-x"},
            "model:\n  extra_body:\n    reasoning:\n      effort: low\n    order:\n      - a\n  provider: openrouter\n":
                {"provider": "openrouter"},
            "model:\n  fallbacks: []\n  empty: {}\n  default: x\n": {"default": "x"},
            "model:\n# a comment at column 0\n  default: x\n\n  provider: y\n": {"default": "x", "provider": "y"},
            "toolsets:\n- a\n- b\nmodel:\n  default: x\n": {"default": "x"},
            "note: |\n  model: not this one\nmodel:\n  default: x\n": {"default": "x"},
            'agent:\n  prompt: "folded over\n    two lines: and # more"\nmodel:\n  default: x\n': {"default": "x"},
            "a: [1, 'two', {b: c}]\nmodel:\n  default: x\n": {"default": "x"},
            "cron:\n  model: m\nmodel:\n  default: x\n": {"default": "x"},
            # The tests' own shape (test_zzz_managed_runner.py).
            "model:\n  provider: openrouter\n  default: configured-model\n":
                {"provider": "openrouter", "default": "configured-model"},
        }
        for text, expected in accepted.items():
            with self.subTest(text=text):
                self.assertEqual(read(text), expected)
                if yaml:
                    self.assertEqual(pyyaml(text), (True, expected))

    @unittest.skipUnless(yaml, "PyYAML is the differential reference")
    def test_differential_against_pyyaml(self):
        # Where yaml.safe_load reads a text, the stdlib reader gives the same `model` (kept keys) or refuses; it never
        # gives a different answer. Valid-biased texts mostly read; refusals there are typed kept values or duplicates.
        for seed, count, hostile in ((20261029, 1500, False), (31, 1500, True)):
            stats = {"equal": 0, "refused": 0, "pyyaml-error": 0}
            for text in generated(seed, count, hostile):
                ok, expected = pyyaml(text)
                got = read(text)
                if not ok:
                    stats["pyyaml-error"] += 1
                elif got == REFUSED:
                    stats["refused"] += 1
                else:
                    self.assertEqual((got, type(got)), (expected, type(expected)), text)
                    stats["equal"] += 1
            with self.subTest(seed=seed, stats=stats):
                self.assertGreater(stats["equal"], count // (30 if hostile else 2))

    def test_model_route_reads_the_writer_shapes(self):
        # Through the stdlib fallback (PyYAML blocked) and, where it is importable, through yaml.safe_load.
        for blocked in (True, False) if yaml else (True,):
            with self.subTest(pyyaml_blocked=blocked), patch.dict(sys.modules, {"yaml": None} if blocked else {}):
                self.check_model_route(blocked)

    def check_model_route(self, blocked):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            texts = self.fixtures()
            (home / ".env").write_text("OPENROUTER_API_KEY=fixture-openrouter\nOPENAI_API_KEY=fixture-openai\n")
            for name, expected in (
                    ("hermes-odin-model-put", ("https://openrouter.ai/api/v1", "fixture-openrouter", "anthropic/claude-opus-5.5")),
                    ("hermes-openai-direct", ("https://api.openai.com/v1", "fixture-openai", "gpt-5.4-mini")),
                    ("hermes-auto-provider", ("https://openrouter.ai/api/v1", "fixture-openrouter", "x-ai/grok-4")),
                    ("installer-model-and-fallback", ("https://openrouter.ai/api/v1", "fixture-openrouter",
                                                      "anthropic/claude-haiku-4.5"))):
                with self.subTest(name):
                    (home / "config.yaml").write_text(texts[name])
                    self.assertEqual(runner._model_route(home), expected)
            for name, code in (("hermes-bare-model-string", "model-name"), ("hermes-ambiguous-words", "model-route")):
                with self.subTest(name):
                    (home / "config.yaml").write_text(texts[name])
                    with self.assertRaisesRegex(ValueError, f"^{code}$"):
                        runner._model_route(home)
            # An anchor: PyYAML reads it (no `default`, so model-name); the fallback refuses it.
            (home / "config.yaml").write_text("model:\n  provider: &p openrouter\n")
            with self.assertRaisesRegex(ValueError, "^model-config$" if blocked else "^model-name$"):
                runner._model_route(home)


# Shapes PyYAML reads that the strict fallback refuses (review-b ov#550 S1): with PyYAML importable they must read
# exactly as yaml.safe_load, as the v2.1.21 runner did.
PYYAML_ONLY = {
    "document start": "---\nmodel:\n  provider: openrouter\n  default: anthropic/claude-haiku-4.5\n",
    "anchor, alias and tag": "base: &p openrouter\nmodel:\n  provider: *p\n  default: !!str anthropic/claude-haiku-4.5\n",
    "tab in a quoted string": 'model:\n  provider: openrouter\n  default: "anthropic/claude-haiku-4.5"\nagent:\n  note: "a\tb"\n',
    "lone carriage returns": "model:\r  provider: openrouter\r  default: anthropic/claude-haiku-4.5\r",
}


class TestPyYamlFirst(unittest.TestCase):
    def home(self, text):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        home = Path(temp.name).resolve()
        (home / ".env").write_text("OPENROUTER_API_KEY=fixture-openrouter\n")
        (home / "config.yaml").write_bytes(text.encode())
        return home

    @unittest.skipUnless(yaml, "PyYAML importable")
    def test_pyyaml_reads_the_route_when_importable(self):
        route = ("https://openrouter.ai/api/v1", "fixture-openrouter", "anthropic/claude-haiku-4.5")
        for name, text in PYYAML_ONLY.items():
            with self.subTest(name):
                self.assertEqual(read(text), REFUSED)  # the fallback alone would refuse it
                with patch.object(runner, "_model_config", side_effect=AssertionError("fallback used")):
                    self.assertEqual(runner._model_section(text.encode()), yaml.safe_load(text)["model"])
                    self.assertEqual(runner._model_route(self.home(text)), route)

    def test_the_stdlib_reader_is_used_only_when_pyyaml_is_blocked(self):
        fixture = (FIXTURES / "hermes-odin-model-put.yaml").read_bytes()
        with patch.dict(sys.modules, {"yaml": None}):
            with patch.object(runner, "_model_config", wraps=runner._model_config) as reader:
                self.assertEqual(runner._model_section(fixture), {
                    "default": "anthropic/claude-opus-5.5", "provider": "openrouter",
                    "base_url": "https://openrouter.ai/api/v1"})
                self.assertEqual(reader.call_count, 1)
            for name, text in PYYAML_ONLY.items():
                with self.subTest(name):
                    with self.assertRaisesRegex(ValueError, "^model-config$"):
                        runner._model_route(self.home(text))


class TestReasonLine(unittest.TestCase):
    def test_only_safe_codes_reach_stderr(self):
        cases = (
            (ValueError("model-provider"), "model-provider"), (TimeoutError("deadline"), "deadline"),
            (ValueError("current policy paused"), "-"), (KeyError("expiresAt"), "-"),
            (FileNotFoundError(2, "No such file or directory", "/home/resident/.hermes/config.yaml"), "ENOENT"),
            (PermissionError(13, "Permission denied", "/x"), "EACCES"), (ValueError(TOKEN), "-"),
            (ValueError("fixture-key-" + "f" * 64), "-"), (ValueError("Model-Provider"), "-"), (ValueError(""), "-"),
            (ValueError("a/b"), "-"), (OSError("no errno"), "-"),
        )
        for error, code in cases:
            with self.subTest(error=repr(error)):
                self.assertEqual(runner._reason(error), code)
        previous = runner._step
        try:
            runner._enter("model_route")
            self.assertEqual(runner.reason_line(ValueError("model-provider")),
                             "zzz-autonomy: model_route ValueError model-provider\n")
            runner._enter("config")
            line = runner.reason_line(FileNotFoundError(2, "No such file", "/secret/path/village-bridge.json"))
            self.assertEqual(line, "zzz-autonomy: config FileNotFoundError ENOENT\n")
        finally:
            runner._step = previous
        self.assertEqual(runner.STEPS, ("home", "installed", "config", "job", "model_route", "lock", "state", "claim",
                                        "turn"))


class FakeHttp:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class ShippedRunnerHome:
    """A temp HERMES_HOME holding a byte copy of the shipped runner where the installer stages it (scripts/)."""

    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()  # macOS /var is a symlink; the runner refuses linked parents
        (self.home / "cron").mkdir()
        (self.home / "scripts").mkdir()
        self.script = self.home / "scripts" / runner.JOB_SCRIPT
        shutil.copyfile(SCRIPT, self.script)
        self.bridge(days=1)
        (self.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": [
            {"id": "zzzbot", "version": "1.0.0", "skills": ["zzzbot"], "operations": [
                "zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread"]},
            {"id": "zzz-autonomy-runner", "version": "1.0.0", "operations": [], "skills": []}]}))
        self.job = {"id": "a" * 12, "name": runner.JOB_NAME, "prompt": runner.PROMPT, "script": runner.JOB_SCRIPT,
                    "enabled": True, "no_agent": True, "enabled_toolsets": ["no_mcp"], "workdir": None,
                    "deliver": "local", "failure_deliver": "local",
                    "schedule": {"kind": "cron", "expr": runner.schedule(TOKEN)}, "repeat": {"times": None}}
        self.save_job()
        (self.home / "config.yaml").write_text((FIXTURES / "hermes-odin-model-put.yaml").read_text(encoding="utf-8"))
        (self.home / ".env").write_text("OPENROUTER_API_KEY=fixture-openrouter\n")

    def bridge(self, days):
        (self.home / "village-bridge.json").write_text(json.dumps({
            "origin": "https://agents.edgecity.live", "token": TOKEN,
            "expiresAt": (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()}))

    def save_job(self):
        (self.home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [self.job]}))


class TestShippedRunnerWithoutPackages(unittest.TestCase):
    """The runner as shipped, run from a copy by an interpreter with no third-party package at all (a bare venv: the
    `--no-install import chain` rule, box scripts are package-free end to end up to the claim)."""

    @classmethod
    def setUpClass(cls):
        cls.venv = tempfile.TemporaryDirectory()
        venv.EnvBuilder(with_pip=False, symlinks=os.name != "nt").create(cls.venv.name)
        cls.python = str(Path(cls.venv.name) / "bin" / "python3")
        for module in ("yaml", "httpx", "openai"):
            probe = subprocess.run([cls.python, "-I", "-c", f"import {module}"], capture_output=True, timeout=60)
            assert probe.returncode != 0, f"{module} is importable in the bare venv"

    @classmethod
    def tearDownClass(cls):
        cls.venv.cleanup()

    def setUp(self):
        self.box = ShippedRunnerHome()
        self.addCleanup(self.box.temp.cleanup)

    def run_runner(self, *flags, home=None):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HERMES_HOME": str(home or self.box.home)}
        result = subprocess.run([self.python, *flags, str(self.box.script)], env=env, cwd=self.box.home,
                                capture_output=True, timeout=120)
        self.assertEqual(result.stdout, b"")
        for secret in (TOKEN, "fixture-openrouter", str(self.box.home)):
            self.assertNotIn(secret.encode(), result.stderr)
        return result.returncode, result.stderr.decode()

    def test_every_pre_claim_step_passes_with_the_standard_library_alone(self):
        # As Hermes runs it (the runner re-execs itself under -I) and under an explicit -I: home, installed, config,
        # job, model_route (the stdlib reader), lock and state all pass, and the first non-stdlib import, at the claim,
        # fails with a named code before any request.
        for flags in ((), ("-I",)):
            with self.subTest(flags=flags):
                self.assertEqual(self.run_runner(*flags), (1, "zzz-autonomy: claim ValueError http-client\n"))
                self.assertTrue((self.box.home / "zzzbot" / "autonomy-run.lock").is_file())  # the lock step ran
                self.assertFalse((self.box.home / "zzzbot" / runner.BACKOFF_FILE).exists())  # no claim, no turn

    def test_each_failure_names_its_step_and_a_safe_code(self):
        def missing_bridge():
            (self.box.home / "village-bridge.json").unlink()

        def missing_model_config():
            (self.box.home / "config.yaml").unlink()

        def bad_provider():
            (self.box.home / "config.yaml").write_text("model:\n  provider: anthropic\n  default: claude-opus-5.5\n")

        def refused_config():
            (self.box.home / "config.yaml").write_text("model:\n  provider: &p openrouter\n  default: x/y\n")

        def expired_bridge():
            self.box.bridge(days=-1)

        def job_shape():
            self.box.job["prompt"] = "something else"
            self.box.save_job()

        cases = (
            (missing_bridge, "zzz-autonomy: config FileNotFoundError ENOENT\n"),
            (missing_model_config, "zzz-autonomy: model_route FileNotFoundError ENOENT\n"),
            (bad_provider, "zzz-autonomy: model_route ValueError model-provider\n"),
            (refused_config, "zzz-autonomy: model_route ValueError model-config\n"),
            (expired_bridge, "zzz-autonomy: config ValueError bridge-expired\n"),
            (job_shape, "zzz-autonomy: job ValueError job-shape\n"),
        )
        for change, line in cases:
            with self.subTest(line=line):
                self.box = ShippedRunnerHome()
                self.addCleanup(self.box.temp.cleanup)
                change()
                self.assertEqual(self.run_runner(), (1, line))
                self.assertFalse((self.box.home / "zzzbot").exists())  # every one stops before the lock

    def test_the_canary_route_passes_the_model_route_step(self):
        # RUNNER-MODEL-RESOLVE (canary aa9a5de3): provider auto, the OpenRouter base_url and key in config.yaml, no
        # key in .env. v2.1.22 stopped here at `model_route ValueError model-provider`; now the claim step is next.
        (self.box.home / "config.yaml").write_text(
            "model:\n  default: anthropic/claude-haiku-5.5\n  provider: auto\n  base_url: https://openrouter.ai/api/v1\n"
            "  api_key: fixture-openrouter\nfallback_providers:\n  - provider: openrouter\n    model: openai/gpt-6-luna\n")
        (self.box.home / ".env").write_text("HERMES_MODEL=anthropic/claude-haiku-5.5\n")
        self.assertEqual(self.run_runner(), (1, "zzz-autonomy: claim ValueError http-client\n"))

    def test_a_foreign_hermes_home_is_the_home_step(self):
        with tempfile.TemporaryDirectory() as other:
            self.assertEqual(self.run_runner(home=Path(other).resolve()), (1, "zzz-autonomy: home ValueError home\n"))

    def test_an_absent_projection_entry_exits_cleanly(self):
        (self.box.home / "mini-apps.json").write_text(json.dumps({"version": 1, "apps": []}))
        self.assertEqual(self.run_runner(), (0, ""))


class TestClientsBeforeClaim(unittest.TestCase):
    def setUp(self):
        self.addCleanup(logging.disable, logging.root.manager.disable)  # run() quiets logging process-wide
        self.box = ShippedRunnerHome()
        self.addCleanup(self.box.temp.cleanup)

    def run_without(self, modules, code):
        ops = []
        with patch.dict(sys.modules, modules), \
                patch.object(runner, "_activity", side_effect=lambda *_a, **_k: ops.append("claim")):
            with self.assertRaisesRegex(ValueError, f"^{code}$"):
                runner.run(self.box.home)
        self.assertEqual(runner._step, "claim")
        self.assertEqual(ops, [])

    def test_missing_http_client_stops_before_the_claim(self):
        self.run_without({"httpx": None}, "http-client")

    def test_missing_model_client_stops_before_the_claim(self):
        # A claim without the model client would spend one of the candidate's two attempts and a daily turn.
        self.run_without({"httpx": SimpleNamespace(Client=lambda **_: FakeHttp()), "openai": None}, "model-client")


if __name__ == "__main__":
    unittest.main()
