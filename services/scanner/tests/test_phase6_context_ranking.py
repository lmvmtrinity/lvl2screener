from datetime import timedelta
from uuid import UUID

from app.models import ScannerProfileConfig
from app.strategies.base import BenchmarkObservation, StrategyContext
from app.strategy_engine import StrategyEngine
from test_feature_engine import five_minute_history, quote, warmed_engine


def _engine() -> StrategyEngine:
    engine = StrategyEngine()
    engine.configure_profiles([
        ScannerProfileConfig(
            profileId=UUID(int=60), profileName="Market context",
            strategy="MARKET_RELATIVE_STRENGTH", analysisKind="CONTEXT",
            configVersion="phase6-context-v1",
        ),
    ])
    return engine


def test_context_records_versioned_raw_session_horizon_evidence() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0].model_copy(update={"change_from_open_pct": 1.25, "rolling_return_5m_pct": .6})
    benchmark = BenchmarkObservation("XIU.TO", .25, snapshot.timestamp, "REALTIME", True, rolling_return_5m_pct=.1)

    context = _engine().evaluate(snapshot, StrategyContext(bars=five_minute_history(), market_benchmark=benchmark))[2][0]

    assert context.status == "STRONG"
    assert context.context_score_version == "context-score-v2"
    assert context.observed_value == 1
    assert context.missing_data_flags == []
    assert len(context.context_score_components) == 2
    component = context.context_score_components[0]
    assert component.horizon == context.lookback == "SESSION_FROM_OPEN"
    assert component.candidate_value == 1.25
    assert component.benchmark_value == .25
    assert component.observed_difference == context.observed_value
    assert component.score == context.context_score
    assert component.available is True
    rolling = context.context_score_components[1]
    assert rolling.horizon == "ROLLING_5_MINUTES"
    assert rolling.candidate_value == .6
    assert rolling.benchmark_value == .1
    assert rolling.observed_difference == .5
    assert rolling.available is True


def test_missing_context_is_explicitly_neutral_with_flags() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]

    context = _engine().evaluate(snapshot, StrategyContext(bars=five_minute_history()))[2][0]

    assert context.status == "UNAVAILABLE"
    assert context.context_score == 50
    assert context.observed_value is None
    assert context.missing_data_flags == ["BENCHMARK_UNAVAILABLE"]
    component = context.context_score_components[0]
    assert component.score == 50 and component.available is False
    assert component.observed_difference is None
    assert component.missing_data_flags == context.missing_data_flags


def test_stale_benchmark_cannot_contribute_a_favourable_context_score() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0].model_copy(update={"change_from_open_pct": 8})
    benchmark = BenchmarkObservation("XIU.TO", -8, snapshot.timestamp - timedelta(minutes=1), "REALTIME", True)

    context = _engine().evaluate(snapshot, StrategyContext(
        bars=five_minute_history(), market_benchmark=benchmark, benchmark_max_staleness_seconds=30,
    ))[2][0]

    assert context.status == "STALE"
    assert context.context_score == 50
    assert context.observed_value is None
    assert context.missing_data_flags == ["BENCHMARK_STALE"]
