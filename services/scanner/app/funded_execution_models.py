from __future__ import annotations

import json
from collections.abc import Callable
from hashlib import sha256
from math import exp, log, sqrt
from statistics import fmean, median
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

OutputUnit = Literal["PROBABILITY", "FRACTION", "CURRENCY_PER_SHARE", "CURRENCY"]

FEATURE_NAMES: tuple[str, ...] = (
    "deterministicScore",
    "spreadPct",
    "logDisplayedSize",
    "logRequestedNotional",
    "logRequestedRisk",
    "quoteAgeSeconds",
    "minutesFromOpen",
    "atrPct",
    "stopDistancePct",
    "targetDistancePct",
    "logCash",
    "logOpenRisk",
    "logReservedRisk",
    "positionCount",
    "participation",
    "contextStrength",
)
OUTPUT_NAMES: tuple[str, ...] = (
    "fillProbability",
    "expectedFillFraction",
    "expectedSlippagePerShare",
    "expectedTotalExecutionCost",
)
ARTIFACT_VERSION: Literal["funded-execution-v1"] = "funded-execution-v1"
MODEL_TYPE: Literal["FUNDED_EXECUTION_QUALITY"] = "FUNDED_EXECUTION_QUALITY"
FEATURE_VERSION: Literal["funded-execution-features-v1"] = "funded-execution-features-v1"
TRAINING_CODE_VERSION = "funded-execution-trainer-v1"
ITERATIONS = 1_500
LEARNING_RATE = 0.05
L2_PENALTY = 0.1


class _AliasedModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class _StrictModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class FundedExecutionFeatureVector(_AliasedModel):
    model_config = ConfigDict(
        populate_by_name=True, extra="ignore", allow_inf_nan=False
    )

    deterministic_score: float | None = Field(default=None, alias="deterministicScore")
    spread_pct: float | None = Field(default=None, alias="spreadPct")
    log_displayed_size: float | None = Field(default=None, alias="logDisplayedSize")
    log_requested_notional: float | None = Field(default=None, alias="logRequestedNotional")
    log_requested_risk: float | None = Field(default=None, alias="logRequestedRisk")
    quote_age_seconds: float | None = Field(default=None, alias="quoteAgeSeconds")
    minutes_from_open: float | None = Field(default=None, alias="minutesFromOpen")
    atr_pct: float | None = Field(default=None, alias="atrPct")
    stop_distance_pct: float | None = Field(default=None, alias="stopDistancePct")
    target_distance_pct: float | None = Field(default=None, alias="targetDistancePct")
    log_cash: float | None = Field(default=None, alias="logCash")
    log_open_risk: float | None = Field(default=None, alias="logOpenRisk")
    log_reserved_risk: float | None = Field(default=None, alias="logReservedRisk")
    position_count: float | None = Field(default=None, alias="positionCount")
    participation: float | None = Field(default=None, alias="participation")
    context_strength: float | None = Field(default=None, alias="contextStrength")

    def ordered_values(self) -> list[float | None]:
        return [
            self.deterministic_score,
            self.spread_pct,
            self.log_displayed_size,
            self.log_requested_notional,
            self.log_requested_risk,
            self.quote_age_seconds,
            self.minutes_from_open,
            self.atr_pct,
            self.stop_distance_pct,
            self.target_distance_pct,
            self.log_cash,
            self.log_open_risk,
            self.log_reserved_risk,
            self.position_count,
            self.participation,
            self.context_strength,
        ]


class FundedExecutionLabels(_AliasedModel):
    model_config = ConfigDict(
        populate_by_name=True, extra="ignore", allow_inf_nan=False
    )

    fill_probability: Literal[0, 1] | None = Field(default=None, alias="fillProbability")
    fill_fraction: float | None = Field(default=None, alias="fillFraction", ge=0, le=1)
    slippage_per_share: float | None = Field(default=None, alias="slippagePerShare", ge=0)
    total_execution_cost: float | None = Field(default=None, alias="totalExecutionCost", ge=0)


class FundedExecutionTrainingRow(_AliasedModel):
    model_config = ConfigDict(
        populate_by_name=True, extra="ignore", allow_inf_nan=False
    )

    market_id: Literal["CA_TSX", "US_EQUITIES"] = Field(alias="marketId")
    currency: Literal["CAD", "USD"]
    run_id: str = Field(alias="runId")
    observation_id: str = Field(alias="observationId")
    decision_sequence: int = Field(alias="decisionSequence", ge=1)
    decision_content_digest: str = Field(alias="decisionContentDigest")
    decision_at: str = Field(alias="decisionAt")
    session_date: str = Field(alias="sessionDate")
    partition: Literal["TRAIN", "TEST"]
    features: FundedExecutionFeatureVector
    labels: FundedExecutionLabels
    row_digest: str = Field(alias="rowDigest")


class FundedExecutionTrainingRequest(_AliasedModel):
    model_config = ConfigDict(
        populate_by_name=True, extra="ignore", allow_inf_nan=False
    )

    request_version: Literal["funded-execution-training-v1"] = Field(alias="requestVersion")
    market_id: Literal["CA_TSX", "US_EQUITIES"] = Field(alias="marketId")
    currency: Literal["CAD", "USD"]
    cohort_digest: str = Field(alias="cohortDigest")
    dataset_digest: str = Field(alias="datasetDigest")
    membership_digest: str = Field(alias="membershipDigest")
    training_partition_digest: str = Field(alias="trainingPartitionDigest")
    feature_version: Literal["funded-execution-features-v1"] = Field(alias="featureVersion")
    label_mapping_version: str = Field(alias="labelMappingVersion")
    feature_names: list[str] = Field(alias="featureNames")
    source_kind: Literal["LIVE_PAPER", "HISTORICAL_REPLAY"] = Field(alias="sourceKind")
    rows: list[FundedExecutionTrainingRow]

    @model_validator(mode="after")
    def validate_request(self) -> FundedExecutionTrainingRequest:
        if tuple(self.feature_names) != FEATURE_NAMES:
            raise ValueError("Funded execution feature order is frozen")
        expected_currency = "CAD" if self.market_id == "CA_TSX" else "USD"
        if self.currency != expected_currency:
            raise ValueError("Funded execution market and currency must match")
        partitions = {row.partition for row in self.rows}
        if partitions != {"TRAIN", "TEST"}:
            raise ValueError("Frozen train and test membership is required")
        seen: set[tuple[str, str]] = set()
        for row in self.rows:
            if row.market_id != self.market_id or row.currency != self.currency:
                raise ValueError("Training rows cannot cross market or currency")
            key = (row.run_id, row.observation_id)
            if key in seen:
                raise ValueError("Duplicate training row identity")
            seen.add(key)
        return self


class FundedExecutionCalibrationBin(_AliasedModel):
    lower: float
    upper: float
    samples: int
    predicted_rate: float = Field(alias="predictedRate")
    observed_rate: float = Field(alias="observedRate")


class FundedExecutionLogisticMetrics(_AliasedModel):
    kind: Literal["LOGISTIC"] = "LOGISTIC"
    samples: int
    positives: int
    negatives: int
    base_rate: float = Field(alias="baseRate")
    brier_score: float = Field(alias="brierScore")
    baseline_brier_score: float = Field(alias="baselineBrierScore")
    log_loss: float = Field(alias="logLoss")
    roc_auc: float | None = Field(alias="rocAuc")
    calibration: list[FundedExecutionCalibrationBin]


class FundedExecutionLinearMetrics(_AliasedModel):
    kind: Literal["LINEAR"] = "LINEAR"
    samples: int
    mean_predicted: float = Field(alias="meanPredicted")
    mean_actual: float = Field(alias="meanActual")
    mean_absolute_error: float = Field(alias="meanAbsoluteError")
    root_mean_squared_error: float = Field(alias="rootMeanSquaredError")


class FundedExecutionOutputHead(_StrictModel):
    output: str
    kind: Literal["LOGISTIC", "LINEAR"]
    unit: Literal["PROBABILITY", "FRACTION", "CURRENCY_PER_SHARE", "CURRENCY"]
    lower_bound: float = Field(alias="lowerBound")
    upper_bound: float | None = Field(alias="upperBound")
    training_samples: int = Field(alias="trainingSamples")
    intercept: float
    coefficients: list[float]
    means: list[float]
    scales: list[float]
    medians: list[float]
    train_metrics: FundedExecutionLogisticMetrics | FundedExecutionLinearMetrics = Field(
        alias="trainMetrics"
    )
    test_metrics: FundedExecutionLogisticMetrics | FundedExecutionLinearMetrics = Field(
        alias="testMetrics"
    )


class FundedExecutionModelArtifact(_StrictModel):
    artifact_version: Literal["funded-execution-v1"] = Field(alias="artifactVersion")
    model_type: Literal["FUNDED_EXECUTION_QUALITY"] = Field(alias="modelType")
    feature_version: Literal["funded-execution-features-v1"] = Field(alias="featureVersion")
    feature_names: list[str] = Field(alias="featureNames")
    source_dataset_digest: str = Field(alias="sourceDatasetDigest")
    training_partition_digest: str = Field(alias="trainingPartitionDigest")
    training_row_count: int = Field(alias="trainingRowCount")
    training_fill_row_count: int = Field(alias="trainingFillRowCount")
    training_cost_row_count: int = Field(alias="trainingCostRowCount")
    outputs: list[FundedExecutionOutputHead]
    warnings: list[str]

    @model_validator(mode="after")
    def validate_artifact(self) -> FundedExecutionModelArtifact:
        if self.feature_names != list(FEATURE_NAMES):
            raise ValueError("Artifact feature order is frozen")
        if [head.output for head in self.outputs] != list(OUTPUT_NAMES):
            raise ValueError("Artifact output order is frozen")
        return self


class FundedExecutionTrainingResult(_StrictModel):
    status: Literal["COMPLETED", "INSUFFICIENT_DATA"]
    artifact: FundedExecutionModelArtifact | None
    artifact_digest: str | None = Field(alias="artifactDigest")
    warnings: list[str]


class FundedExecutionInferenceInput(_AliasedModel):
    run_id: str = Field(alias="runId")
    observation_id: str = Field(alias="observationId")
    decision_sequence: int = Field(alias="decisionSequence", ge=1)
    decision_input_digest: str = Field(alias="decisionInputDigest")
    features: FundedExecutionFeatureVector


class FundedExecutionModelIdentity(_StrictModel):
    model_id: str = Field(alias="modelId")
    model_version: str = Field(alias="modelVersion")
    model_type: Literal["FUNDED_EXECUTION_QUALITY"] = Field(alias="modelType")
    artifact_digest: str = Field(alias="artifactDigest")
    cohort_digest: str = Field(alias="cohortDigest")
    feature_version: Literal["funded-execution-features-v1"] = Field(alias="featureVersion")


class FundedExecutionInferenceRequest(_StrictModel):
    request_version: Literal["funded-execution-inference-v1"] = Field(alias="requestVersion")
    market_id: Literal["CA_TSX", "US_EQUITIES"] = Field(alias="marketId")
    currency: Literal["CAD", "USD"]
    model: FundedExecutionModelIdentity
    artifact: FundedExecutionModelArtifact
    inputs: list[FundedExecutionInferenceInput]


class FundedExecutionDiagnosticValue(_StrictModel):
    value: float
    unit: Literal["PROBABILITY", "FRACTION", "CURRENCY_PER_SHARE", "CURRENCY"]
    lower_bound: float = Field(alias="lowerBound")
    upper_bound: float | None = Field(alias="upperBound")


class FundedExecutionPredictionOutput(_StrictModel):
    fill_probability: FundedExecutionDiagnosticValue = Field(alias="fillProbability")
    expected_fill_fraction: FundedExecutionDiagnosticValue = Field(
        alias="expectedFillFraction"
    )
    expected_slippage_per_share: FundedExecutionDiagnosticValue = Field(
        alias="expectedSlippagePerShare"
    )
    expected_total_execution_cost: FundedExecutionDiagnosticValue = Field(
        alias="expectedTotalExecutionCost"
    )


class FundedExecutionInferencePrediction(_StrictModel):
    run_id: str = Field(alias="runId")
    observation_id: str = Field(alias="observationId")
    decision_sequence: int = Field(alias="decisionSequence")
    decision_input_digest: str = Field(alias="decisionInputDigest")
    output: FundedExecutionPredictionOutput
    warnings: list[str]


class FundedExecutionInferenceOutput(_StrictModel):
    request_version: Literal["funded-execution-inference-v1"] = Field(alias="requestVersion")
    market_id: Literal["CA_TSX", "US_EQUITIES"] = Field(alias="marketId")
    currency: Literal["CAD", "USD"]
    model: FundedExecutionModelIdentity
    predictions: list[FundedExecutionInferencePrediction]
    warnings: list[str]


def canonical_json(value: object) -> str:
    """Canonical JSON shared with the TypeScript artifact-digest boundary.

    Object keys are sorted, arrays keep order, and every finite number is
    formatted with exactly twelve decimals (negative zero normalized), so the
    same artifact produces identical bytes in both languages.
    """
    return _canonical(value)


def artifact_digest(artifact: FundedExecutionModelArtifact) -> str:
    return sha256(
        canonical_json(artifact.model_dump(by_alias=True)).encode("utf-8")
    ).hexdigest()


def train(request: FundedExecutionTrainingRequest) -> FundedExecutionTrainingResult:
    warnings: list[str] = []
    ordered = sorted(
        request.rows,
        key=lambda row: (
            row.partition,
            row.decision_at,
            row.run_id,
            row.observation_id,
        ),
    )
    training = [row for row in ordered if row.partition == "TRAIN"]
    testing = [row for row in ordered if row.partition == "TEST"]

    raw_training = [row.features.ordered_values() for row in training]
    medians = [_median_present(raw_training, index) for index in range(len(FEATURE_NAMES))]
    complete_training = [_impute(row, medians) for row in raw_training]
    means = [
        _round(fmean(row[index] for row in complete_training), 12)
        for index in range(len(FEATURE_NAMES))
    ]
    scales = [
        max(
            _round(
                sqrt(
                    fmean(
                        (row[index] - means[index]) ** 2 for row in complete_training
                    )
                ),
                12,
            ),
            1e-9,
        )
        for index in range(len(FEATURE_NAMES))
    ]
    x_train = [_standardize(row, means, scales) for row in complete_training]
    x_test = [
        _standardize(_impute(row.features.ordered_values(), medians), means, scales)
        for row in testing
    ]

    fill_train = _fill_labels(training)
    fill_test = _fill_labels(testing)
    if (
        len(set(fill_train)) < 2
        or len(set(fill_test)) < 2
        or len(fill_train) < 2
        or len(fill_test) < 2
    ):
        return FundedExecutionTrainingResult(
            status="INSUFFICIENT_DATA",
            artifact=None,
            artifact_digest=None,
            warnings=[
                "Both chronological partitions must contain filled and unfilled rows."
            ],
        )

    fill_coefficients, fill_intercept = _fit_logistic(
        x_train, fill_train, L2_PENALTY
    )
    fill_head = FundedExecutionOutputHead(
        output="fillProbability",
        kind="LOGISTIC",
        unit="PROBABILITY",
        lower_bound=0,
        upper_bound=1,
        training_samples=len(fill_train),
        intercept=fill_intercept,
        coefficients=fill_coefficients,
        means=means,
        scales=scales,
        medians=medians,
        train_metrics=_logistic_metrics(fill_train, _probabilities(x_train, fill_intercept, fill_coefficients), []),
        test_metrics=_logistic_metrics(
            fill_test,
            _probabilities(x_test, fill_intercept, fill_coefficients),
            _calibration_bins(fill_test, _probabilities(x_test, fill_intercept, fill_coefficients)),
        ),
    )

    heads: list[FundedExecutionOutputHead] = [fill_head]
    output_specs: tuple[
        tuple[str, OutputUnit, Callable[[FundedExecutionTrainingRow], float | None]],
        ...,
    ] = (
        (
            "expectedFillFraction",
            "FRACTION",
            lambda row: row.labels.fill_fraction,
        ),
        (
            "expectedSlippagePerShare",
            "CURRENCY_PER_SHARE",
            lambda row: row.labels.slippage_per_share,
        ),
        (
            "expectedTotalExecutionCost",
            "CURRENCY",
            lambda row: row.labels.total_execution_cost,
        ),
    )
    for output, unit, extractor in output_specs:
        train_targets = [
            value
            for row in training
            if (value := extractor(row)) is not None
        ]
        train_rows = [
            index
            for index, row in enumerate(training)
            if extractor(row) is not None
        ]
        test_targets = [
            value
            for row in testing
            if (value := extractor(row)) is not None
        ]
        test_rows = [
            index
            for index, row in enumerate(testing)
            if extractor(row) is not None
        ]
        if len(train_targets) < 2 or len(test_targets) < 1:
            warnings.append(
                f"Output {output} has insufficient masked labels; no artifact was produced."
            )
            return FundedExecutionTrainingResult(
                status="INSUFFICIENT_DATA",
                artifact=None,
                artifact_digest=None,
                warnings=warnings,
            )
        if unit == "FRACTION" and any(
            value < 0 or value > 1 for value in train_targets + test_targets
        ):
            return FundedExecutionTrainingResult(
                status="INSUFFICIENT_DATA",
                artifact=None,
                artifact_digest=None,
                warnings=["Fill fractions must stay within [0, 1]."],
            )
        if unit != "FRACTION" and any(
            value < 0 for value in train_targets + test_targets
        ):
            return FundedExecutionTrainingResult(
                status="INSUFFICIENT_DATA",
                artifact=None,
                artifact_digest=None,
                warnings=["Execution costs and slippage cannot be negative."],
            )
        coefficients, intercept = _fit_linear(
            [x_train[index] for index in train_rows], train_targets
        )
        upper = 1 if unit == "FRACTION" else None
        predictions_train = _clamp(
            [
                intercept
                + sum(
                    weight * value
                    for weight, value in zip(coefficients, row, strict=True)
                )
                for row in (x_train[index] for index in train_rows)
            ],
            0,
            upper,
        )
        predictions_test = _clamp(
            [
                intercept
                + sum(
                    weight * value
                    for weight, value in zip(coefficients, row, strict=True)
                )
                for row in (x_test[index] for index in test_rows)
            ],
            0,
            upper,
        )
        heads.append(
            FundedExecutionOutputHead(
                output=output,
                kind="LINEAR",
                unit=unit,
                lower_bound=0,
                upper_bound=upper,
                training_samples=len(train_targets),
                intercept=intercept,
                coefficients=coefficients,
                means=means,
                scales=scales,
                medians=medians,
                train_metrics=_linear_metrics(train_targets, predictions_train),
                test_metrics=_linear_metrics(test_targets, predictions_test),
            )
        )

    artifact = FundedExecutionModelArtifact(
        artifact_version=ARTIFACT_VERSION,
        model_type=MODEL_TYPE,
        feature_version=FEATURE_VERSION,
        feature_names=list(FEATURE_NAMES),
        source_dataset_digest=request.dataset_digest,
        training_partition_digest=request.training_partition_digest,
        training_row_count=len(training),
        training_fill_row_count=len(fill_train),
        training_cost_row_count=sum(
            1 for row in training if row.labels.total_execution_cost is not None
        ),
        outputs=heads,
        warnings=warnings,
    )
    return FundedExecutionTrainingResult(
        status="COMPLETED",
        artifact=artifact,
        artifact_digest=artifact_digest(artifact),
        warnings=warnings,
    )


def predict(request: FundedExecutionInferenceRequest) -> FundedExecutionInferenceOutput:
    artifact = request.artifact
    if request.model.feature_version != artifact.feature_version:
        raise ValueError("Artifact feature version does not match the model identity")
    if artifact.artifact_version != ARTIFACT_VERSION:
        raise ValueError("Unsupported funded execution artifact version")
    heads = {head.output: head for head in artifact.outputs}
    if tuple(heads) != OUTPUT_NAMES:
        raise ValueError("Artifact output contract is incomplete")
    predictions: list[FundedExecutionInferencePrediction] = []
    for item in request.inputs:
        raw = item.features.ordered_values()
        warnings = [
            f"{FEATURE_NAMES[index]}_MISSING_IMPUTED"
            for index, value in enumerate(raw)
            if value is None
        ]
        row = _standardize(_impute(raw, artifact.outputs[0].medians), artifact.outputs[0].means, artifact.outputs[0].scales)
        fill = heads["fillProbability"]
        fill_value = _sigmoid(_linear(row, fill))
        fraction = heads["expectedFillFraction"]
        fraction_value = _bounded(_linear(row, fraction), 0, 1)
        slippage = heads["expectedSlippagePerShare"]
        slippage_value = _bounded(_linear(row, slippage), 0, None)
        cost = heads["expectedTotalExecutionCost"]
        cost_value = _bounded(_linear(row, cost), 0, None)
        predictions.append(
            FundedExecutionInferencePrediction(
                run_id=item.run_id,
                observation_id=item.observation_id,
                decision_sequence=item.decision_sequence,
                decision_input_digest=item.decision_input_digest,
                output=FundedExecutionPredictionOutput(
                    fill_probability=_diagnostic(fill_value, "PROBABILITY", 0, 1),
                    expected_fill_fraction=_diagnostic(fraction_value, "FRACTION", 0, 1),
                    expected_slippage_per_share=_diagnostic(
                        slippage_value, "CURRENCY_PER_SHARE", 0, None
                    ),
                    expected_total_execution_cost=_diagnostic(
                        cost_value, "CURRENCY", 0, None
                    ),
                ),
                warnings=warnings,
            )
        )
    return FundedExecutionInferenceOutput(
        request_version="funded-execution-inference-v1",
        market_id=request.market_id,
        currency=request.currency,
        model=request.model,
        predictions=predictions,
        warnings=[],
    )


def _diagnostic(
    value: float, unit: OutputUnit, lower: float, upper: float | None
) -> FundedExecutionDiagnosticValue:
    return FundedExecutionDiagnosticValue(
        value=_round(value, 12),
        unit=unit,
        lower_bound=lower,
        upper_bound=upper,
    )


def _fill_labels(rows: list[FundedExecutionTrainingRow]) -> list[int]:
    return [
        row.labels.fill_probability
        for row in rows
        if row.labels.fill_probability is not None
    ]


def _linear(row: list[float], head: FundedExecutionOutputHead) -> float:
    return head.intercept + sum(
        weight * value for weight, value in zip(head.coefficients, row, strict=True)
    )


def _probabilities(
    rows: list[list[float]], intercept: float, coefficients: list[float]
) -> list[float]:
    return [
        _sigmoid(intercept + sum(weight * value for weight, value in zip(coefficients, row, strict=True)))
        for row in rows
    ]


def _fit_logistic(
    rows: list[list[float]], labels: list[int], penalty: float
) -> tuple[list[float], float]:
    coefficients = [0.0] * len(FEATURE_NAMES)
    base = min(max(fmean(labels), 1e-6), 1 - 1e-6)
    intercept = log(base / (1 - base))
    for _ in range(ITERATIONS):
        errors = [
            _sigmoid(intercept + sum(weight * feature for weight, feature in zip(coefficients, row, strict=True))) - label
            for row, label in zip(rows, labels, strict=True)
        ]
        intercept -= LEARNING_RATE * fmean(errors)
        for index in range(len(coefficients)):
            gradient = (
                fmean(error * row[index] for error, row in zip(errors, rows, strict=True))
                + penalty * coefficients[index] / len(rows)
            )
            coefficients[index] -= LEARNING_RATE * gradient
    return [_round(value, 12) for value in coefficients], _round(intercept, 12)


def _fit_linear(
    rows: list[list[float]], targets: list[float]
) -> tuple[list[float], float]:
    coefficients = [0.0] * len(FEATURE_NAMES)
    intercept = fmean(targets)
    for _ in range(ITERATIONS):
        errors = [
            intercept + sum(weight * feature for weight, feature in zip(coefficients, row, strict=True)) - target
            for row, target in zip(rows, targets, strict=True)
        ]
        intercept -= LEARNING_RATE * fmean(errors)
        for index in range(len(coefficients)):
            coefficients[index] -= LEARNING_RATE * fmean(
                error * row[index] for error, row in zip(errors, rows, strict=True)
            )
    return [_round(value, 12) for value in coefficients], _round(intercept, 12)


def _standardize(row: list[float], means: list[float], scales: list[float]) -> list[float]:
    return [
        (value - means[index]) / scales[index]
        for index, value in enumerate(row)
    ]


def _impute(row: list[float | None], medians: list[float]) -> list[float]:
    return [
        medians[index] if value is None else value for index, value in enumerate(row)
    ]


def _median_present(rows: list[list[float | None]], index: int) -> float:
    values: list[float] = [value for row in rows if (value := row[index]) is not None]
    return _round(float(median(values)), 12) if values else 0.0


def _sigmoid(value: float) -> float:
    if value >= 0:
        inverse = exp(-min(value, 700))
        return 1 / (1 + inverse)
    direct = exp(max(value, -700))
    return direct / (1 + direct)


def _bounded(value: float, lower: float, upper: float | None) -> float:
    clipped = max(lower, value)
    return clipped if upper is None else min(upper, clipped)


def _clamp(values: list[float], lower: float, upper: float | None) -> list[float]:
    return [_bounded(value, lower, upper) for value in values]


def _logistic_metrics(
    labels: list[int],
    probabilities: list[float],
    calibration: list[FundedExecutionCalibrationBin],
) -> FundedExecutionLogisticMetrics:
    base = fmean(labels)
    clipped = [min(max(value, 1e-12), 1 - 1e-12) for value in probabilities]
    return FundedExecutionLogisticMetrics(
        samples=len(labels),
        positives=sum(labels),
        negatives=len(labels) - sum(labels),
        base_rate=_round(base, 6),
        brier_score=_round(fmean((probability - label) ** 2 for probability, label in zip(probabilities, labels, strict=True)), 6),
        baseline_brier_score=_round(fmean((base - label) ** 2 for label in labels), 6),
        log_loss=_round(-fmean(label * log(probability) + (1 - label) * log(1 - probability) for label, probability in zip(labels, clipped, strict=True)), 6),
        roc_auc=_auc(labels, probabilities),
        calibration=calibration,
    )


def _linear_metrics(
    targets: list[float], predictions: list[float]
) -> FundedExecutionLinearMetrics:
    errors = [
        prediction - target
        for prediction, target in zip(predictions, targets, strict=True)
    ]
    return FundedExecutionLinearMetrics(
        samples=len(targets),
        mean_predicted=_round(fmean(predictions), 6),
        mean_actual=_round(fmean(targets), 6),
        mean_absolute_error=_round(fmean(abs(error) for error in errors), 6),
        root_mean_squared_error=_round(sqrt(fmean(error**2 for error in errors)), 6),
    )


def _auc(labels: list[int], probabilities: list[float]) -> float | None:
    positives = [value for value, label in zip(probabilities, labels, strict=True) if label]
    negatives = [value for value, label in zip(probabilities, labels, strict=True) if not label]
    if not positives or not negatives:
        return None
    wins = sum(
        1 if positive > negative else 0.5 if positive == negative else 0
        for positive in positives
        for negative in negatives
    )
    return _round(wins / (len(positives) * len(negatives)), 6)


def _calibration_bins(
    labels: list[int], probabilities: list[float]
) -> list[FundedExecutionCalibrationBin]:
    bins: list[FundedExecutionCalibrationBin] = []
    for index in range(5):
        lower, upper = index / 5, (index + 1) / 5
        values = [
            (label, probability)
            for label, probability in zip(labels, probabilities, strict=True)
            if probability >= lower and (probability < upper or index == 4)
        ]
        if values:
            bins.append(
                FundedExecutionCalibrationBin(
                    lower=lower,
                    upper=upper,
                    samples=len(values),
                    predicted_rate=_round(fmean(value[1] for value in values), 6),
                    observed_rate=_round(fmean(value[0] for value in values), 6),
                )
            )
    return bins


def _round(value: float, decimals: int) -> float:
    return float(round(value, decimals))


def _canonical(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        number = float(value)
        if number != number or number in (float("inf"), float("-inf")):
            raise ValueError("Canonical values must be finite")
        normalized = 0.0 if number == 0 else number
        return f"{normalized:.12f}"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=True)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        items = sorted((str(key), item) for key, item in value.items())
        return (
            "{"
            + ",".join(
                json.dumps(key, ensure_ascii=True) + ":" + _canonical(item)
                for key, item in items
            )
            + "}"
        )
    raise ValueError(f"Unsupported canonical value {type(value)!r}")
