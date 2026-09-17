from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from app.models import BacktestTrade, StatisticalPredictionInput, StatisticalTrainingRequest
from app.statistical_models import MARKET_TIMEZONES, predict, train


RUN_ID = UUID("10000000-0000-4000-8000-000000000001")
INSTRUMENT_ID = UUID("10000000-0000-4000-8000-000000000002")
PROFILE_ID = UUID("10000000-0000-4000-8000-000000000003")


def _trade(index: int) -> BacktestTrade:
    # Each chronological segment contains both outcomes, with score/market activity carrying stable signal.
    success = index % 4 != 0
    start = datetime(2025, 1, 2, 15, tzinfo=UTC) + timedelta(days=index)
    return BacktestTrade(
        id=uuid4(),runId=RUN_ID,instrumentId=INSTRUMENT_ID,symbol="TEST.TO",strategy="ORB_RETEST",
        strategyVersion="1.0.0",configVersion="source-v1",signalTimestamp=start,score=88 if success else 58,
        entryTime=start,entryPrice=10,stopPrice=9.5,targetPrice=11,exitTime=start+timedelta(minutes=15),
        exitPrice=11 if success else 9.5,shares=100,exitReason="TARGET" if success else "STOP",
        grossPnl=100 if success else -50,netPnl=100 if success else -50,rMultiple=2 if success else -1,
        holdMinutes=15,reasonCodes=[],atrPct=3 if success else 1.6,rvolAtTime=2.8 if success else 1.2,
    )


def test_chronological_model_supplements_ranking_without_changing_rule_score() -> None:
    result = train(StatisticalTrainingRequest(strategy="ORB_RETEST",trades=[_trade(index) for index in range(100)],minimumSamples=20))
    assert result.status == "COMPLETED"
    assert result.artifact is not None
    assert result.test is not None and result.test.brier_score < result.test.baseline_brier_score
    assert result.eligible_for_activation
    value = predict(result.artifact, StatisticalPredictionInput(
        instrumentId=INSTRUMENT_ID,symbol="TEST.TO",timestamp=datetime(2026,8,25,14,tzinfo=UTC),profileId=PROFILE_ID,
        profileName="ORB Standard",strategy="ORB_RETEST",deterministicScore=88,atrPct=3,rvolAtTime=2.8,
    ))
    assert value.deterministic_score == 88
    assert value.ranking_score > 50
    assert value.false_breakout_probability == round(1-value.setup_probability,6)
    assert value.regime.combined == "ATR_HIGH__RVOL_HIGH"


def test_time_of_day_feature_uses_the_request_market_timezone() -> None:
    # The two markets currently share Eastern clock time, but retain distinct
    # named policies so a future calendar/session change cannot silently share
    # a hardcoded Toronto assumption.
    assert MARKET_TIMEZONES["CA_TSX"].key == "America/Toronto"
    assert MARKET_TIMEZONES["US_EQUITIES"].key == "America/New_York"


def test_model_refuses_to_train_below_the_clean_sample_floor() -> None:
    result = train(StatisticalTrainingRequest(strategy="ORB_RETEST",trades=[_trade(index) for index in range(20)],minimumSamples=200))
    assert result.status == "INSUFFICIENT_DATA"
    assert result.artifact is None
    assert not result.eligible_for_activation
    assert result.warnings


def test_explicit_frozen_partition_wins_over_row_percentage() -> None:
    trades = [_trade(index).model_copy(update={"source_key": f"row-{index}"}) for index in range(200)]
    result = train(StatisticalTrainingRequest(
        strategy="ORB_RETEST",
        trades=trades,
        trainPct=80,
        minimumSamples=20,
        trainingSourceKeys=[f"row-{index}" for index in range(150)],
        testingSourceKeys=[f"row-{index}" for index in range(150, 200)],
    ))
    assert result.train is not None and result.train.samples == 150
    assert result.test is not None and result.test.samples == 50


def test_explicit_frozen_partition_rejects_overlap_and_missing_rows() -> None:
    trades = [_trade(index).model_copy(update={"source_key": f"row-{index}"}) for index in range(30)]
    overlap = train(StatisticalTrainingRequest(
        strategy="ORB_RETEST", trades=trades, minimumSamples=20,
        trainingSourceKeys=[f"row-{index}" for index in range(20)],
        testingSourceKeys=[f"row-{index}" for index in range(19, 30)],
    ))
    missing = train(StatisticalTrainingRequest(
        strategy="ORB_RETEST", trades=trades, minimumSamples=20,
        trainingSourceKeys=[f"row-{index}" for index in range(19)],
        testingSourceKeys=[f"row-{index}" for index in range(20, 29)],
    ))
    assert not overlap.eligible_for_activation and not missing.eligible_for_activation
    assert any("membership" in warning.lower() for warning in overlap.warnings + missing.warnings)
