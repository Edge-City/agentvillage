import hashlib
import importlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

def request(prediction):
    now = datetime.now(timezone.utc)
    frozen_at = now.isoformat().replace("+00:00", "Z")
    value = {"requestId": "request-1", "referendumId": "11111111-1111-4111-8111-111111111111", "frozenAt": frozen_at, "sourceCutoffAt": frozen_at, "question": "Dinner?", "context": "Advisory", "options": [{"optionId": "riva", "label": "Riva"}, {"optionId": "circle", "label": "Circle"}]}
    value["contentSha256"] = hashlib.sha256(prediction.canonical_content(value)).hexdigest()
    return value


def test_tool_free_prediction_and_source_hash(plugin, tmp_path):
    prediction = importlib.import_module(f"{plugin.__name__}.referendum_predict")
    (tmp_path / "USER.md").write_text("Likes rice", encoding="utf-8")
    seen = {}
    def runner(prompt, **kwargs):
        seen.update(prompt=prompt, kwargs=kwargs)
        return json.dumps({"status": "predicted", "probabilities": [{"optionId": "riva", "probability": .8}, {"optionId": "circle", "probability": .2}], "confidence": .7, "abstentionReason": None, "evidence": [{"sourceType": "resident_context", "sourceRef": "USER.md", "summary": "Likes Riva"}]}), {"provider": "openrouter", "model": "resident-model"}
    out = prediction.execute(prediction.validate_request(request(prediction)), runner, tmp_path)
    assert out["status"] == "predicted"
    assert out["model"]["id"] == "resident-model"
    assert seen["kwargs"] == {}
    assert "Likes rice" in seen["prompt"]


def test_no_context_abstains_without_model_call(plugin, tmp_path):
    prediction = importlib.import_module(f"{plugin.__name__}.referendum_predict")
    out = prediction.execute(prediction.validate_request(request(prediction)), lambda _: (_ for _ in ()).throw(AssertionError("called")), tmp_path)
    assert out["status"] == "abstained"
    assert out["abstentionReason"] == "no_usable_resident_context"
    assert len(out["sourceSha256"]) == 64


def test_rejects_content_drift_and_bad_probabilities(plugin, tmp_path):
    prediction = importlib.import_module(f"{plugin.__name__}.referendum_predict")
    value = request(prediction)
    value["question"] = "Changed"
    try:
        prediction.validate_request(value)
        assert False
    except ValueError as exc:
        assert str(exc) == "content_hash_mismatch"
    post_freeze = request(prediction)
    post_freeze["sourceCutoffAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with pytest.raises(ValueError, match="invalid_request"):
        prediction.validate_request(post_freeze)
    bad = json.dumps({"status": "predicted", "probabilities": [{"optionId": "riva", "probability": .8}, {"optionId": "circle", "probability": .8}], "confidence": .7, "abstentionReason": None, "evidence": []})
    try:
        prediction.normalize_model_output(bad, request(prediction), set())
        assert False
    except ValueError as exc:
        assert str(exc) == "prediction_invalid"


def test_nested_memory_is_included_but_symlinked_parent_is_not(plugin, tmp_path):
    prediction = importlib.import_module(f"{plugin.__name__}.referendum_predict")
    cutoff = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat().replace("+00:00", "Z")
    (tmp_path / "memory").mkdir()
    (tmp_path / "memory/MEMORY.md").write_text("nested memory", encoding="utf-8")
    outside = tmp_path.parent / f"outside-{tmp_path.name}"
    outside.mkdir(exist_ok=True)
    (outside / "MEMORY.md").write_text("outside", encoding="utf-8")
    (tmp_path / "memories").symlink_to(outside, target_is_directory=True)
    sources, _ = prediction.source_bundle(tmp_path, cutoff)
    assert [item["sourceRef"] for item in sources] == ["memory/MEMORY.md"]


def test_predicted_output_requires_strict_numbers_sum_and_evidence(plugin):
    prediction = importlib.import_module(f"{plugin.__name__}.referendum_predict")
    value = request(prediction)
    base = {"status": "predicted", "probabilities": [{"optionId": "riva", "probability": .8}, {"optionId": "circle", "probability": .2}], "confidence": .7, "abstentionReason": None, "evidence": [{"sourceType": "resident_context", "sourceRef": "USER.md", "summary": "prefers Riva"}]}
    assert prediction.normalize_model_output(json.dumps(base), value, {"USER.md"})["status"] == "predicted"
    bad_values = [
        {**base, "confidence": True},
        {**base, "probabilities": [{"optionId": "riva", "probability": True}, {"optionId": "circle", "probability": 0}]},
        {**base, "probabilities": [{"optionId": "riva", "probability": .50001}, {"optionId": "circle", "probability": .49998}]},
        {**base, "evidence": []},
    ]
    for bad in bad_values:
        with pytest.raises(ValueError, match="prediction_invalid"):
            prediction.normalize_model_output(json.dumps(bad), value, {"USER.md"})


def test_valid_request_runtime_failure_keeps_terminal_hash_metadata(plugin, tmp_path):
    prediction = importlib.import_module(f"{plugin.__name__}.referendum_predict")
    (tmp_path / "USER.md").write_text("resident source", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, prediction.__file__], input=json.dumps(request(prediction)), text=True,
        capture_output=True, env={**os.environ, "HERMES_HOME": str(tmp_path)}, check=True,
    )
    value = json.loads(proc.stdout)
    assert value["status"] == "failed"
    assert value["abstentionReason"] == "prediction_failed"
    assert len(value["promptSha256"]) == len(value["sourceSha256"]) == 64
