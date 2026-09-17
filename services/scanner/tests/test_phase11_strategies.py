from datetime import timedelta
from uuid import UUID

import pytest

from app.feature_engine import FeatureEngine
from app.models import BenchmarkRef, InstrumentRef, ScannerProfileConfig, StrategyParameters
from app.strategies import CONTEXT_REGISTRY, STRATEGY_REGISTRY
from app.strategies.base import BenchmarkObservation, StrategyContext
from app.strategy_engine import StrategyEngine
from test_feature_engine import INSTRUMENT_ID, SESSION_START, daily_history, five_minute_history, minute_history, quote, session, warmed_engine
from test_strategy_engine import bar


PHASE_11 = (
    "VWAP_RECLAIM",
    "RSI_VWAP_RECLAIM",
    "HIGH_OF_DAY_BREAKOUT",
    "BULL_FLAG",
    "PRIOR_DAY_HIGH_BREAKOUT",
    "SECTOR_RELATIVE_STRENGTH",
    "MARKET_RELATIVE_STRENGTH",
)


def engine_for(strategy: str, **parameters: float) -> StrategyEngine:
    profile = ScannerProfileConfig(
        profile_id=UUID("20000000-0000-4000-8000-000000000001"),
        profile_name=strategy,
        strategy=strategy,
        analysis_kind="CONTEXT" if strategy in CONTEXT_REGISTRY else "SETUP",
        config_version="phase11-test",
        parameters=StrategyParameters(**parameters),
    )
    engine = StrategyEngine()
    engine.configure_profiles([profile])
    return engine


def evaluation(strategy: str, bars, context: StrategyContext | None = None, **updates):
    snapshot = warmed_engine().ingest_quotes([quote()])[0].model_copy(update=updates)
    return engine_for(strategy).evaluate(snapshot, context or StrategyContext(bars=bars))[0][0]


def context_evaluation(signal: str, context: StrategyContext, **updates):
    snapshot = warmed_engine().ingest_quotes([quote()])[0].model_copy(update=updates)
    return engine_for(signal).evaluate(snapshot, context)[2][0]


def test_all_phase_11_strategies_are_independent_versioned_modules() -> None:
    modules = {**STRATEGY_REGISTRY, **CONTEXT_REGISTRY}
    assert set(PHASE_11).issubset(modules)
    assert {modules[key].version for key in PHASE_11} == {"1.0.0"}
    assert not set(CONTEXT_REGISTRY).intersection(STRATEGY_REGISTRY)


def test_vwap_reclaim_requires_a_later_hold_bar() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    first = bar(5, 99.8, 100.5, 99.7, 100.3, 500)
    second = bar(6, 100.3, 101, 100.1, 100.8, 600)
    engine = engine_for("VWAP_RECLAIM")
    forming = engine.evaluate(snapshot.model_copy(update={"timestamp": first.end, "price": first.close, "vwap": 100, "completed_bar_vwap": 100, "vwap_reclaim": True}), [first])[0][0]
    ready = engine.evaluate(snapshot.model_copy(update={"timestamp": second.end, "price": second.close, "vwap": 100, "completed_bar_vwap": 100, "vwap_reclaim": False}), [first, second])[0][0]
    assert forming.state == "FORMING"
    assert ready.state == "READY"
    assert "VWAP_RECLAIM_HELD" in ready.reason_codes


@pytest.mark.parametrize(
    ("strategy", "context", "reason"),
    [
        ("HIGH_OF_DAY_BREAKOUT", StrategyContext(bars=[
            bar(0, 99.5, 99.9, 99.4, 99.8, 100), bar(1, 99.7, 99.95, 99.6, 99.85, 100), bar(2, 99.8, 100, 99.7, 99.9, 100),
            bar(3, 99.9, 101.2, 99.8, 101, 250),
        ]), "HIGH_OF_DAY_BREAKOUT_CONFIRMED"),
        ("PRIOR_DAY_HIGH_BREAKOUT", StrategyContext(bars=[bar(2, 99, 99.8, 98.8, 99.5, 100), bar(3, 99.5, 101.2, 99.4, 101, 250)], prior_day_high=100), "PRIOR_DAY_HIGH_BREAKOUT_CONFIRMED"),
    ],
)
def test_level_breakouts_require_completed_close_and_volume(strategy: str, context: StrategyContext, reason: str) -> None:
    latest = context.bars[-1]
    result = evaluation(strategy, context.bars, context, timestamp=latest.end, price=latest.close)
    assert result.state == "READY"
    assert reason in result.reason_codes
    assert result.entry_reference is not None
    assert result.stop_reference is not None
    assert result.target_reference is not None
    assert result.estimated_rr is not None and result.estimated_rr > 0


def test_bull_flag_detects_impulse_controlled_pullback_and_continuation() -> None:
    bars = [
        bar(0, 100, 100.8, 99.8, 100.7, 900),
        bar(1, 100.7, 101.8, 100.6, 101.6, 1_000),
        bar(2, 101.6, 102.6, 101.5, 102.4, 1_100),
        bar(3, 102.4, 102.55, 101.9, 102.1, 400),
        bar(4, 102.1, 102.35, 101.95, 102.2, 350),
        bar(5, 102.2, 103.2, 102.1, 103, 1_100),
    ]
    result = evaluation("BULL_FLAG", bars, timestamp=bars[-1].end, price=bars[-1].close)
    assert result.state == "READY"
    assert "BULL_FLAG_CONFIRMED" in result.reason_codes


@pytest.mark.parametrize(
    ("strategy", "context", "reason"),
    [
        ("SECTOR_RELATIVE_STRENGTH", StrategyContext(bars=five_minute_history(), sector="Materials", sector_benchmark=BenchmarkObservation("XMA.TO",.1,quote().timestamp, "REALTIME",True)), "SECTOR_RELATIVE_STRENGTH_STRONG"),
        ("MARKET_RELATIVE_STRENGTH", StrategyContext(bars=five_minute_history(), market_benchmark=BenchmarkObservation("XIU.TO",.1,quote().timestamp,"REALTIME",True)), "MARKET_RELATIVE_STRENGTH_STRONG"),
    ],
)
def test_relative_strength_uses_stable_benchmark_without_trade_state(strategy: str, context: StrategyContext, reason: str) -> None:
    result = context_evaluation(strategy, context, change_from_open_pct=1.2)
    assert result.status == "STRONG"
    assert reason in result.reason_codes
    assert result.benchmark_symbol in ("XMA.TO", "XIU.TO")
    assert not hasattr(result, "entry_reference")


def test_relative_strength_stays_inactive_when_peer_context_is_unavailable() -> None:
    result = context_evaluation("SECTOR_RELATIVE_STRENGTH", StrategyContext(bars=five_minute_history()))
    assert result.status == "UNAVAILABLE"
    assert "SECTOR_BENCHMARK_UNAVAILABLE" in result.reason_codes


@pytest.mark.parametrize(
    ("strategy", "context", "failure_reason"),
    [
        (
            "HIGH_OF_DAY_BREAKOUT",
            StrategyContext(bars=[
                bar(0, 99.5, 99.9, 99.4, 99.8, 100),
                bar(1, 99.7, 99.95, 99.6, 99.85, 100),
                bar(2, 99.8, 100, 99.7, 99.9, 100),
                bar(3, 99.9, 101.2, 99.8, 101, 250),
            ]),
            "HIGH_OF_DAY_BREAKOUT_FAILED",
        ),
        (
            "PRIOR_DAY_HIGH_BREAKOUT",
            StrategyContext(bars=[
                bar(2, 99, 99.8, 98.8, 99.5, 100),
                bar(3, 99.5, 101.2, 99.4, 101, 250),
            ], prior_day_high=100),
            "PRIOR_DAY_HIGH_LOST",
        ),
    ],
)
def test_breakout_failure_follows_the_formation_through_watch_state(
    strategy: str, context: StrategyContext, failure_reason: str
) -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    engine = engine_for(strategy)
    first = context.bars[-1]
    ready = engine.evaluate(
        snapshot.model_copy(update={"timestamp": first.end, "price": first.close}),
        context,
    )[0][0]
    assert ready.state == "READY"
    assert ready.setup_instance_id is not None

    continuation = bar(
        4,
        first.close,
        first.close + .1,
        first.close - .1,
        first.close - .2,
        100,
    )
    watched = engine.evaluate(
        snapshot.model_copy(update={"timestamp": continuation.end, "price": continuation.close}),
        StrategyContext(
            bars=[*context.bars, continuation],
            prior_day_high=context.prior_day_high,
        ),
    )[0][0]
    assert watched.state == "WATCH"
    assert watched.setup_instance_id == ready.setup_instance_id

    failure = bar(
        5,
        continuation.close,
        continuation.close + .1,
        99.4,
        99.6,
        100,
    )
    invalidated = engine.evaluate(
        snapshot.model_copy(update={"timestamp": failure.end, "price": failure.close}),
        StrategyContext(
            bars=[*context.bars, continuation, failure],
            prior_day_high=context.prior_day_high,
        ),
    )[0][0]
    assert invalidated.state == "INVALIDATED"
    assert failure_reason in invalidated.reason_codes


def test_relative_strength_rejects_a_halted_candidate_even_with_a_strong_benchmark() -> None:
    context = StrategyContext(
        bars=five_minute_history(),
        sector_benchmark=BenchmarkObservation(
            "XMA.TO", .1, quote().timestamp, "REALTIME", True
        ),
    )
    result = context_evaluation(
        "SECTOR_RELATIVE_STRENGTH",
        context,
        change_from_open_pct=1.2,
        data_status="HALTED",
        actionable=False,
    )
    assert result.status == "UNAVAILABLE"
    assert result.context_score == 50
    assert "CANDIDATE_HALTED" in result.missing_data_flags


def test_feature_engine_builds_prior_day_and_configured_benchmark_context() -> None:
    peer_id = UUID("22222222-2222-4222-8222-222222222222")
    configured = session().model_copy(update={"instruments": [
        InstrumentRef(instrument_id=INSTRUMENT_ID, symbol="TEST.TO", sector="Materials"),
        InstrumentRef(instrument_id=peer_id, symbol="XMA.TO", role="BENCHMARK", benchmark_kind="SECTOR", benchmark_sector="Materials"),
    ], "benchmarks":[BenchmarkRef(kind="SECTOR",symbol="XMA.TO",sector="Materials")]})
    engine = FeatureEngine()
    engine.start_session(configured)
    primary = [*daily_history(), *minute_history(), *five_minute_history()]
    peer = [value.model_copy(update={"instrument_id": peer_id, "symbol": "XMA.TO"}) for value in primary]
    engine.ingest_candles([*primary, *peer])
    primary_quote = quote()
    peer_quote = quote().model_copy(update={"instrument_id": peer_id, "symbol": "XMA.TO", "last": 113.22})
    snapshots = engine.ingest_quotes([primary_quote, peer_quote])

    context = engine.strategy_context(snapshots[0])
    assert context.prior_day_high == daily_history()[-1].high
    assert context.sector_benchmark is not None
    assert context.sector_benchmark.symbol == "XMA.TO"
    assert context.sector_benchmark.change_from_open_pct == pytest.approx((peer_quote.last - peer_quote.day_open) / peer_quote.day_open * 100)
    assert all(value.start >= SESSION_START for value in context.bars)


def test_candidate_edits_cannot_change_the_configured_benchmark_value() -> None:
    other_id = UUID("33333333-3333-4333-8333-333333333333")
    benchmark_id = UUID("44444444-4444-4444-8444-444444444444")
    configured = session().model_copy(update={"instruments": [
        InstrumentRef(instrument_id=INSTRUMENT_ID, symbol="TEST.TO", sector="Materials"),
        InstrumentRef(instrument_id=other_id, symbol="OTHER.TO", sector="Materials"),
        InstrumentRef(instrument_id=benchmark_id, symbol="XMA.TO", role="BENCHMARK", benchmark_kind="SECTOR", benchmark_sector="Materials"),
    ], "benchmarks":[BenchmarkRef(kind="SECTOR",symbol="XMA.TO",sector="Materials")]})
    engine = FeatureEngine()
    engine.start_session(configured)
    primary = quote()
    benchmark = quote().model_copy(update={"instrument_id":benchmark_id,"symbol":"XMA.TO","last":110.5})
    primary_snapshot = engine.ingest_quotes([primary, benchmark])[0]
    before = engine.strategy_context(primary_snapshot).sector_benchmark
    other = quote().model_copy(update={"instrument_id":other_id,"symbol":"OTHER.TO","last":140})
    engine.ingest_quotes([other])
    after = engine.strategy_context(primary_snapshot).sector_benchmark
    assert before == after


def test_stale_benchmark_only_disables_the_dependent_context_signal() -> None:
    benchmark_id = UUID("44444444-4444-4444-8444-444444444444")
    configured = session().model_copy(update={"instruments": [
        InstrumentRef(instrument_id=INSTRUMENT_ID, symbol="TEST.TO", sector="Materials"),
        InstrumentRef(instrument_id=benchmark_id, symbol="XMA.TO", role="BENCHMARK", benchmark_kind="SECTOR", benchmark_sector="Materials"),
    ], "benchmarks":[BenchmarkRef(kind="SECTOR",symbol="XMA.TO",sector="Materials")], "benchmark_max_staleness_seconds":30})
    engine = FeatureEngine()
    engine.start_session(configured)
    engine.strategies.configure_profiles([
        ScannerProfileConfig(profile_id=UUID("20000000-0000-4000-8000-000000000010"), profile_name="ORB",
                             strategy="ORB_RETEST", analysis_kind="SETUP", config_version="stale-test"),
        ScannerProfileConfig(profile_id=UUID("20000000-0000-4000-8000-000000000011"), profile_name="Sector Context",
                             strategy="SECTOR_RELATIVE_STRENGTH", analysis_kind="CONTEXT", config_version="stale-test"),
    ])
    engine.ingest_candles([*daily_history(), *minute_history(), *five_minute_history()])
    candidate = quote()
    stale = quote().model_copy(update={"instrument_id": benchmark_id, "symbol": "XMA.TO", "timestamp": candidate.timestamp - timedelta(minutes=2)})
    snapshot = [value for value in engine.ingest_quotes([candidate, stale]) if value.instrument_id == INSTRUMENT_ID][0]

    setups, _events, contexts = engine.strategies.evaluate(snapshot, engine.strategy_context(snapshot))

    assert [value.status for value in contexts] == ["STALE"]
    assert contexts[0].observed_value is None
    assert contexts[0].reason_codes == ["SECTOR_RELATIVE_STRENGTH_BENCHMARK_STALE"]
    assert [value.strategy for value in setups] == ["ORB_RETEST"]
    assert setups[0].state not in ("DATA_STALE", "HALTED")
    readiness = engine.benchmark_readiness()
    assert [(value.symbol, value.status, value.reason) for value in readiness.sectors] == [("XMA.TO", "STALE", "BENCHMARK_TIMESTAMP_STALE")]


def test_benchmark_instruments_are_never_replayed_as_trade_candidates() -> None:
    from app.backtest import replay
    from app.models import BacktestAssumptions, BacktestReplayRequest, BacktestSession

    benchmark_id = UUID("44444444-4444-4444-8444-444444444444")
    baseline = bar(5, 99, 100, 98.8, 99.8, 100)
    breakout = bar(6, 99.8, 101.2, 99.7, 101, 250)
    configured = session().model_copy(update={"instruments": [
        InstrumentRef(instrument_id=INSTRUMENT_ID, symbol="TEST.TO", sector="Materials"),
        InstrumentRef(instrument_id=benchmark_id, symbol="XMA.TO", role="BENCHMARK", benchmark_kind="SECTOR", benchmark_sector="Materials"),
    ], "benchmarks":[BenchmarkRef(kind="SECTOR",symbol="XMA.TO",sector="Materials")]})
    captured = quote().model_copy(update={"timestamp": breakout.end, "last": breakout.close, "day_high": breakout.high})
    benchmark_quote = captured.model_copy(update={"instrument_id": benchmark_id, "symbol": "XMA.TO"})
    benchmark_candles = [value.model_copy(update={"instrument_id": benchmark_id, "symbol": "XMA.TO"})
                         for value in [*daily_history(), *minute_history(), baseline, breakout]]

    result = replay(BacktestReplayRequest(
        run_id=UUID("10000000-0000-4000-8000-0000000000a1"), config_version="benchmark-replay",
        strategies=["HIGH_OF_DAY_BREAKOUT"],
        assumptions=BacktestAssumptions(starting_capital=100_000, position_size=10_000, slippage_bps=0, fee_per_trade=0),
        sessions=[BacktestSession(session=configured, candles=[*daily_history(), *minute_history(), baseline, breakout, *benchmark_candles],
                                  quotes=[captured, benchmark_quote])],
    ))

    assert {value.symbol for value in result.timeline} == {"TEST.TO"}
    assert all(value.symbol != "XMA.TO" for value in result.trades)
