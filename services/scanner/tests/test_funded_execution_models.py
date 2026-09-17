from datetime import UTC, datetime, timedelta
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.funded_execution_models import (
    FEATURE_NAMES,
    FundedExecutionInferenceInput,
    FundedExecutionInferenceRequest,
    FundedExecutionLabels,
    FundedExecutionModelArtifact,
    FundedExecutionTrainingRequest,
    FundedExecutionTrainingRow,
    artifact_digest,
    canonical_json,
    predict,
    train,
)

FIXTURES = Path(__file__).parent / "fixtures"

MARKET = "CA_TSX"
CURRENCY = "CAD"
DIGEST = "a" * 64
COHORT_DIGEST = "b" * 64


def _features(index: int, missing: bool = False) -> dict[str, float | None]:
    values: dict[str, float | None] = {
        "deterministicScore": 60 + (index % 40),
        "spreadPct": 0.1 + (index % 5) * 0.01,
        "logDisplayedSize": 5 + (index % 3),
        "logRequestedNotional": 7.3,
        "logRequestedRisk": 5.5,
        "quoteAgeSeconds": 1 + (index % 4),
        "minutesFromOpen": 5 + (index % 30),
        "atrPct": 0.01 + (index % 5) * 0.002,
        "stopDistancePct": 0.02,
        "targetDistancePct": 0.05,
        "logCash": 9.2,
        "logOpenRisk": 0.5,
        "logReservedRisk": 0.2,
        "positionCount": index % 3,
        "participation": 0.25,
        "contextStrength": 2,
    }
    if missing:
        values["atrPct"] = None
        values["contextStrength"] = None
    return values


def _labels(index: int, *, cost: bool = True) -> dict[str, object]:
    filled = index % 2 == 0
    return {
        "fillProbability": 1 if filled else 0,
        "fillFraction": 1 if filled else 0,
        "slippagePerShare": 0.01 if filled and cost else None,
        "totalExecutionCost": 1.0 if filled and cost else None,
        "costLabelAvailable": filled and cost,
    }


def _row(index: int, partition: str, *, cost: bool = True) -> FundedExecutionTrainingRow:
    session = "2026-09-08" if partition == "TRAIN" else "2026-09-15"
    start = datetime(2026, 9, 8, 14, 30, tzinfo=UTC) + timedelta(
        minutes=index if partition == "TRAIN" else index + 20_000
    )
    return FundedExecutionTrainingRow(
        marketId=MARKET,
        currency=CURRENCY,
        runId="run-1",
        observationId=f"{partition.lower()}-{index:03d}",
        decisionSequence=index + 1,
        decisionContentDigest=DIGEST,
        decisionAt=start.isoformat(),
        sessionDate=session,
        partition=partition,
        features=_features(index, missing=index % 10 == 0),
        labels=_labels(index, cost=cost),
        rowDigest=DIGEST,
    )


def _request(**overrides: object) -> FundedExecutionTrainingRequest:
    payload: dict[str, object] = {
        "requestVersion": "funded-execution-training-v1",
        "marketId": MARKET,
        "currency": CURRENCY,
        "cohortDigest": COHORT_DIGEST,
        "datasetDigest": DIGEST,
        "membershipDigest": COHORT_DIGEST,
        "trainingPartitionDigest": DIGEST,
        "featureVersion": "funded-execution-features-v1",
        "labelMappingVersion": "funded-execution-labels-v1",
        "featureNames": list(FEATURE_NAMES),
        "sourceKind": "LIVE_PAPER",
        "rows": [
            _row(index, "TRAIN") for index in range(100)
        ]
        + [_row(index, "TEST") for index in range(100)],
    }
    payload.update(overrides)
    return FundedExecutionTrainingRequest.model_validate(payload)


def test_training_is_deterministic_and_byte_stable() -> None:
    first = train(_request())
    second = train(_request())
    assert first.status == "COMPLETED"
    assert first.artifact is not None
    assert first.artifact_digest is not None
    assert second.artifact is not None
    assert canonical_json(first.artifact.model_dump(by_alias=True)) == canonical_json(
        second.artifact.model_dump(by_alias=True)
    )
    assert first.artifact_digest == artifact_digest(second.artifact)
    assert first.artifact_digest == artifact_digest(first.artifact)


def test_artifact_reports_every_output_with_sample_counts_and_units() -> None:
    result = train(_request())
    assert result.artifact is not None
    artifact = result.artifact
    assert [head.output for head in artifact.outputs] == [
        "fillProbability",
        "expectedFillFraction",
        "expectedSlippagePerShare",
        "expectedTotalExecutionCost",
    ]
    assert [head.unit for head in artifact.outputs] == [
        "PROBABILITY",
        "FRACTION",
        "CURRENCY_PER_SHARE",
        "CURRENCY",
    ]
    assert artifact.training_row_count == 100
    assert artifact.training_fill_row_count == 100
    assert artifact.training_cost_row_count == 50
    for head in artifact.outputs:
        assert head.training_samples > 0
        assert len(head.coefficients) == len(FEATURE_NAMES)
        assert len(head.means) == len(FEATURE_NAMES)
        assert len(head.scales) == len(FEATURE_NAMES)
        assert len(head.medians) == len(FEATURE_NAMES)
        assert head.test_metrics.samples > 0
    fill_head = artifact.outputs[0]
    assert fill_head.kind == "LOGISTIC"
    assert 0 <= fill_head.test_metrics.base_rate <= 1  # type: ignore[union-attr]
    fraction_head = artifact.outputs[1]
    assert fraction_head.upper_bound == 1
    with pytest.raises(ValidationError):
        type(artifact)(**{**artifact.model_dump(by_alias=True), "action": "SUBMIT"})


def test_rejects_feature_order_mismatch_and_cross_market_rows() -> None:
    names = list(FEATURE_NAMES)
    names[0], names[1] = names[1], names[0]
    with pytest.raises(ValidationError):
        _request(featureNames=names)
    with pytest.raises(ValidationError):
        _request(currency="USD")
    rows = [_row(index, "TRAIN").model_dump(by_alias=True) for index in range(100)]
    rows += [_row(index, "TEST").model_dump(by_alias=True) for index in range(100)]
    rows[0]["marketId"] = "US_EQUITIES"
    rows[0]["currency"] = "USD"
    with pytest.raises(ValidationError):
        FundedExecutionTrainingRequest.model_validate(
            {
                **_request().model_dump(by_alias=True),
                "rows": rows,
            }
        )


def test_masked_cost_objectives_fail_closed_without_labels() -> None:
    request = _request()
    rows = []
    for row in request.rows:
        payload = row.model_dump(by_alias=True)
        labels = dict(payload["labels"])
        labels["slippagePerShare"] = None
        labels["totalExecutionCost"] = None
        labels["costLabelAvailable"] = False
        payload["labels"] = labels
        rows.append(payload)
    result = train(
        FundedExecutionTrainingRequest.model_validate(
            {**request.model_dump(by_alias=True), "rows": rows}
        )
    )
    assert result.status == "INSUFFICIENT_DATA"
    assert result.artifact is None
    assert result.warnings


def test_rejects_negative_costs_and_out_of_range_fractions() -> None:
    with pytest.raises(ValidationError):
        FundedExecutionLabels.model_validate(
            {"fillProbability": 1, "fillFraction": 1.5}
        )
    with pytest.raises(ValidationError):
        FundedExecutionLabels.model_validate(
            {"fillProbability": 1, "fillFraction": 1, "totalExecutionCost": -1}
        )
    with pytest.raises(ValidationError):
        FundedExecutionLabels.model_validate(
            {
                "fillProbability": 1,
                "fillFraction": 1,
                "totalExecutionCost": float("nan"),
            }
        )
    with pytest.raises(ValidationError):
        FundedExecutionLabels.model_validate(
            {
                "fillProbability": 1,
                "fillFraction": 1,
                "slippagePerShare": float("inf"),
            }
        )


def test_inference_is_deterministic_and_bounded_with_explicit_units() -> None:
    trained = train(_request())
    assert trained.artifact is not None
    request = FundedExecutionInferenceRequest(
        requestVersion="funded-execution-inference-v1",
        marketId=MARKET,
        currency=CURRENCY,
        model={
            "modelId": "model-1",
            "modelVersion": "funded-execution-v1",
            "modelType": "FUNDED_EXECUTION_QUALITY",
            "artifactDigest": trained.artifact_digest,
            "cohortDigest": COHORT_DIGEST,
            "featureVersion": "funded-execution-features-v1",
        },
        artifact=trained.artifact,
        inputs=[
            FundedExecutionInferenceInput(
                runId="run-1",
                observationId="observation-1",
                decisionSequence=1,
                decisionInputDigest=DIGEST,
                features=_features(0, missing=True),
            ),
            FundedExecutionInferenceInput(
                runId="run-1",
                observationId="observation-2",
                decisionSequence=2,
                decisionInputDigest=DIGEST,
                features=_features(1),
            ),
        ],
    )
    first = predict(request)
    second = predict(request)
    assert canonical_json(first.model_dump(by_alias=True)) == canonical_json(
        second.model_dump(by_alias=True)
    )
    assert len(first.predictions) == 2
    first_prediction = first.predictions[0]
    assert "atrPct_MISSING_IMPUTED" in first_prediction.warnings
    assert first_prediction.output.fill_probability.unit == "PROBABILITY"
    assert 0 <= first_prediction.output.fill_probability.value <= 1
    assert 0 <= first_prediction.output.expected_fill_fraction.value <= 1
    assert first_prediction.output.expected_slippage_per_share.value >= 0
    assert first_prediction.output.expected_total_execution_cost.value >= 0
    assert first_prediction.output.expected_total_execution_cost.unit == "CURRENCY"
    dumped = first.model_dump(by_alias=True)
    assert "action" not in dumped
    assert "positionSize" not in dumped

def test_committed_cross_language_request_reproduces_the_python_result_fixture() -> None:
    request = FundedExecutionTrainingRequest.model_validate(
        json.loads((FIXTURES / "funded_execution_request.json").read_text(encoding="utf-8"))
    )
    result = train(request)
    assert result.status == "COMPLETED"
    assert result.artifact is not None
    committed = json.loads(
        (FIXTURES / "funded_execution_result.json").read_text(encoding="utf-8")
    )
    assert canonical_json(result.model_dump(by_alias=True)) == canonical_json(committed)
    assert result.artifact_digest == artifact_digest(result.artifact)


def test_committed_python_result_artifact_digest_is_reproducible() -> None:
    committed = json.loads(
        (FIXTURES / "funded_execution_result.json").read_text(encoding="utf-8")
    )
    artifact = FundedExecutionModelArtifact.model_validate(committed["artifact"])
    assert committed["artifactDigest"] == artifact_digest(artifact)
