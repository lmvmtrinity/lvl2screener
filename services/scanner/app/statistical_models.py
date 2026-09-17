from datetime import datetime
from math import exp, log, log1p, sqrt
from statistics import fmean, median
from zoneinfo import ZoneInfo

from .models import (
    BacktestTrade,
    StatisticalCalibrationBin,
    StatisticalDatasetMetrics,
    StatisticalModelArtifact,
    StatisticalPrediction,
    StatisticalPredictionInput,
    StatisticalRegime,
    StatisticalTrainingRequest,
    StatisticalTrainingResult,
)


FEATURE_NAMES = ["deterministicScore", "atrPct", "logRvolAtTime", "minutesFromOpen"]
MARKET_TIMEZONES = {
    "CA_TSX": ZoneInfo("America/Toronto"),
    "US_EQUITIES": ZoneInfo("America/New_York"),
}


def train(request: StatisticalTrainingRequest) -> StatisticalTrainingResult:
    trades = sorted((trade for trade in request.trades if trade.strategy == request.strategy), key=lambda value: value.entry_time)
    warnings: list[str] = []
    if len(trades) < request.minimum_samples:
        warnings.append(f"Only {len(trades)} strategy trades are available; at least {request.minimum_samples} are required.")
        return _insufficient(trades, warnings)
    if request.training_source_keys is not None or request.testing_source_keys is not None:
        train_keys = set(request.training_source_keys or [])
        test_keys = set(request.testing_source_keys or [])
        if (
            not train_keys
            or not test_keys
            or len(request.training_source_keys or []) != len(train_keys)
            or len(request.testing_source_keys or []) != len(test_keys)
            or train_keys & test_keys
        ):
            return _insufficient(trades, ["Frozen chronological train/test membership is invalid."])
        by_key = {trade.source_key: trade for trade in trades if trade.source_key}
        if (
            len(by_key) != len(trades)
            or train_keys | test_keys != set(by_key)
            or not train_keys.issubset(by_key)
            or not test_keys.issubset(by_key)
        ):
            return _insufficient(trades, ["Frozen chronological membership does not cover the supplied evidence rows."])
        training = sorted((by_key[key] for key in train_keys), key=lambda value: value.entry_time)
        testing = sorted((by_key[key] for key in test_keys), key=lambda value: value.entry_time)
        if training[-1].entry_time >= testing[0].entry_time:
            return _insufficient(trades, ["Frozen chronological membership is not ordered."] , training, testing)
    else:
        split = max(1, min(len(trades) - 1, int(len(trades) * request.train_pct / 100)))
        training, testing = trades[:split], trades[split:]
    train_labels, test_labels = _labels(training), _labels(testing)
    if len(set(train_labels)) < 2 or len(set(test_labels)) < 2:
        warnings.append("Both chronological segments must contain successful and unsuccessful setups.")
        return _insufficient(trades, warnings, training, testing)

    raw_training = [_raw_features(value, request.market_id) for value in training]
    medians = [_median_present(raw_training, index) for index in range(len(FEATURE_NAMES))]
    if any(value.atr_pct is None or value.rvol_at_time is None for value in trades):
        warnings.append("Missing ATR/RVOL values were imputed from training medians and are disclosed per prediction.")
    complete_training = [_impute(value, medians) for value in raw_training]
    means = [fmean(row[index] for row in complete_training) for index in range(len(FEATURE_NAMES))]
    scales = [max(sqrt(fmean((row[index] - means[index]) ** 2 for row in complete_training)), 1e-9) for index in range(len(FEATURE_NAMES))]
    x_train = [_standardize(row, means, scales) for row in complete_training]
    coefficients, intercept = _fit(x_train, train_labels, request.l2_penalty)
    artifact = StatisticalModelArtifact(
        feature_names=FEATURE_NAMES, intercept=intercept, coefficients=coefficients, means=means, scales=scales,
        medians=medians, atr_median=medians[1], rvol_median=max(0, exp(medians[2]) - 1),
    )
    train_probabilities = [_probability(artifact, _raw_features(value, request.market_id))[0] for value in training]
    test_probabilities = [_probability(artifact, _raw_features(value, request.market_id))[0] for value in testing]
    training_base_rate = fmean(train_labels)
    train_metrics = _metrics(train_labels, train_probabilities, training_base_rate)
    test_metrics = _metrics(test_labels, test_probabilities, training_base_rate)
    eligible = test_metrics.brier_score < test_metrics.baseline_brier_score
    if not eligible:
        warnings.append("The chronological holdout Brier score does not improve on its base-rate forecast; activation is blocked.")
    return StatisticalTrainingResult(
        status="COMPLETED", artifact=artifact, train=train_metrics, test=test_metrics,
        calibration=_calibration(test_labels, test_probabilities), eligible_for_activation=eligible, warnings=warnings,
        training_start=training[0].entry_time, training_end=training[-1].entry_time,
        test_start=testing[0].entry_time, test_end=testing[-1].entry_time,
    )


def predict(artifact: StatisticalModelArtifact, value: StatisticalPredictionInput) -> StatisticalPrediction:
    raw = [value.deterministic_score / 100, value.atr_pct, None if value.rvol_at_time is None else log1p(max(0, value.rvol_at_time)), _minutes(value.timestamp, value.market_id)]
    probability, contributions = _probability(artifact, raw)
    warnings = []
    if value.atr_pct is None:
        warnings.append("ATR_MISSING_IMPUTED")
    if value.rvol_at_time is None:
        warnings.append("RVOL_MISSING_IMPUTED")
    atr = "UNKNOWN" if value.atr_pct is None else "HIGH" if value.atr_pct >= artifact.atr_median else "LOW"
    rvol = "UNKNOWN" if value.rvol_at_time is None else "HIGH" if value.rvol_at_time >= artifact.rvol_median else "LOW"
    return StatisticalPrediction(
        market_id=value.market_id, instrument_id=value.instrument_id, symbol=value.symbol, timestamp=value.timestamp, profile_id=value.profile_id,
        profile_name=value.profile_name, strategy=value.strategy, deterministic_score=value.deterministic_score,
        setup_probability=round(probability, 6), false_breakout_probability=round(1 - probability, 6),
        ranking_score=round(probability * 100), regime=StatisticalRegime(atr=atr, rvol=rvol, combined=f"ATR_{atr}__RVOL_{rvol}"),
        contributions={name: round(amount, 6) for name, amount in zip(artifact.feature_names, contributions, strict=True)}, warnings=warnings,
    )


def _insufficient(trades: list[BacktestTrade], warnings: list[str], training: list[BacktestTrade] | None = None, testing: list[BacktestTrade] | None = None) -> StatisticalTrainingResult:
    training = training or []
    testing = testing or []
    return StatisticalTrainingResult(
        status="INSUFFICIENT_DATA", artifact=None, train=None, test=None, calibration=[], eligible_for_activation=False, warnings=warnings,
        training_start=training[0].entry_time if training else None, training_end=training[-1].entry_time if training else None,
        test_start=testing[0].entry_time if testing else None, test_end=testing[-1].entry_time if testing else None,
    )


def _raw_features(trade: BacktestTrade, market_id: str) -> list[float | None]:
    return [trade.score / 100, trade.atr_pct, None if trade.rvol_at_time is None else log1p(max(0, trade.rvol_at_time)), _minutes(trade.entry_time, market_id)]


def _minutes(value: datetime, market_id: str) -> float:
    local = value.astimezone(MARKET_TIMEZONES[market_id])
    return float(local.hour * 60 + local.minute - 570)


def _median_present(rows: list[list[float | None]], index: int) -> float:
    values: list[float] = [value for row in rows if (value := row[index]) is not None]
    return float(median(values)) if values else 0


def _impute(row: list[float | None], medians: list[float]) -> list[float]:
    return [medians[index] if value is None else value for index, value in enumerate(row)]


def _standardize(row: list[float], means: list[float], scales: list[float]) -> list[float]:
    return [(value - means[index]) / scales[index] for index, value in enumerate(row)]


def _fit(rows: list[list[float]], labels: list[int], penalty: float) -> tuple[list[float], float]:
    coefficients = [0.0] * len(FEATURE_NAMES)
    base = min(max(fmean(labels), 1e-6), 1 - 1e-6)
    intercept = log(base / (1 - base))
    rate = .05
    for _ in range(1_500):
        errors = [_sigmoid(intercept + sum(weight * feature for weight, feature in zip(coefficients, row, strict=True))) - label for row, label in zip(rows, labels, strict=True)]
        intercept -= rate * fmean(errors)
        for index in range(len(coefficients)):
            gradient = fmean(error * row[index] for error, row in zip(errors, rows, strict=True)) + penalty * coefficients[index] / len(rows)
            coefficients[index] -= rate * gradient
    return [round(value, 12) for value in coefficients], round(intercept, 12)


def _sigmoid(value: float) -> float:
    if value >= 0:
        inverse = exp(-min(value, 700))
        return 1 / (1 + inverse)
    direct = exp(max(value, -700))
    return direct / (1 + direct)


def _probability(artifact: StatisticalModelArtifact, raw: list[float | None]) -> tuple[float, list[float]]:
    row = _standardize(_impute(raw, artifact.medians), artifact.means, artifact.scales)
    contributions = [weight * feature for weight, feature in zip(artifact.coefficients, row, strict=True)]
    return _sigmoid(artifact.intercept + sum(contributions)), contributions


def _labels(trades: list[BacktestTrade]) -> list[int]:
    return [1 if trade.r_multiple > 0 else 0 for trade in trades]


def _metrics(labels: list[int], probabilities: list[float], baseline_rate: float) -> StatisticalDatasetMetrics:
    base = fmean(labels)
    clipped = [min(max(value, 1e-12), 1 - 1e-12) for value in probabilities]
    return StatisticalDatasetMetrics(
        samples=len(labels), positives=sum(labels), negatives=len(labels) - sum(labels), base_rate=round(base, 6),
        brier_score=round(fmean((probability - label) ** 2 for probability, label in zip(probabilities, labels, strict=True)), 6),
        baseline_brier_score=round(fmean((baseline_rate - label) ** 2 for label in labels), 6),
        log_loss=round(-fmean(label * log(probability) + (1 - label) * log(1 - probability) for label, probability in zip(labels, clipped, strict=True)), 6),
        roc_auc=_auc(labels, probabilities),
    )


def _auc(labels: list[int], probabilities: list[float]) -> float | None:
    positives = [value for value, label in zip(probabilities, labels, strict=True) if label]
    negatives = [value for value, label in zip(probabilities, labels, strict=True) if not label]
    if not positives or not negatives:
        return None
    wins = sum(1 if positive > negative else .5 if positive == negative else 0 for positive in positives for negative in negatives)
    return round(wins / (len(positives) * len(negatives)), 6)


def _calibration(labels: list[int], probabilities: list[float]) -> list[StatisticalCalibrationBin]:
    bins: list[StatisticalCalibrationBin] = []
    for index in range(5):
        lower, upper = index / 5, (index + 1) / 5
        values = [(label, probability) for label, probability in zip(labels, probabilities, strict=True) if probability >= lower and (probability < upper or index == 4)]
        if values:
            bins.append(StatisticalCalibrationBin(lower=lower, upper=upper, samples=len(values), predicted_rate=round(fmean(value[1] for value in values), 6), observed_rate=round(fmean(value[0] for value in values), 6)))
    return bins
