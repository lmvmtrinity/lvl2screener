from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest

from app.backtest import _local_date, _metrics, _simulate_trades, _time_bucket, replay, replay_signals
from app.models import (
    BacktestAssumptions,
    BacktestReplayRequest,
    BacktestSession,
    BacktestTrade,
    CandleRecord,
    StrategyStateEvent,
)
from test_feature_engine import daily_history, minute_history, quote, session
from test_strategy_engine import bar as strategy_bar


RUN_ID = UUID("10000000-0000-4000-8000-000000000001")
INSTRUMENT_ID = UUID("10000000-0000-4000-8000-000000000002")


def trade(net_pnl: float, r_multiple: float, reason: str = "TARGET") -> BacktestTrade:
    start = datetime(2026, 8, 25, 14, tzinfo=UTC)
    return BacktestTrade(
        id=UUID("10000000-0000-4000-8000-000000000003"),
        run_id=RUN_ID,
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        strategy="ORB_RETEST",
        strategy_version="1.0.0",
        config_version="test-v1",
        signal_timestamp=start,
        score=85,
        entry_time=start,
        entry_price=10,
        stop_price=9.5,
        target_price=11,
        exit_time=start + timedelta(minutes=15),
        exit_price=11,
        shares=100,
        exit_reason=reason,
        gross_pnl=net_pnl,
        net_pnl=net_pnl,
        r_multiple=r_multiple,
        hold_minutes=15,
        reason_codes=[],
    )


def test_metrics_prioritize_expectancy_and_track_drawdown() -> None:
    metrics = _metrics([trade(100, 2), trade(-50, -1, "STOP")], [], 10_000)
    assert metrics.win_rate == 50
    assert metrics.expectancy == 25
    assert metrics.profit_factor == 2
    assert metrics.average_r == 0.5
    assert metrics.maximum_drawdown == 50
    assert metrics.false_breakout_rate == 50


def test_replay_time_buckets_use_the_recorded_market_timezone() -> None:
    timestamp = datetime(2026, 8, 25, 14, 30, tzinfo=UTC)
    assert _time_bucket(timestamp, "America/New_York") == "10:00-10:59"
    assert str(_local_date(timestamp, "America/New_York")) == "2026-08-25"


def test_empty_replay_discloses_missing_market_data() -> None:
    result = replay(
        BacktestReplayRequest(
            run_id=RUN_ID,
            config_version="test-v1",
            strategies=["ORB_RETEST"],
            assumptions=BacktestAssumptions(
                starting_capital=100_000, position_size=10_000, slippage_bps=2, fee_per_trade=9.95
            ),
            sessions=[],
        )
    )
    assert result.metrics.trades_simulated == 0
    assert result.data_quality.spread == "UNAVAILABLE"
    assert result.data_quality.warnings


def test_replay_instantiates_the_requested_phase_11_strategy_module() -> None:
    base = [
        strategy_bar(3, 99.5, 99.9, 99.4, 99.8, 100),
        strategy_bar(4, 99.7, 99.95, 99.6, 99.85, 100),
        strategy_bar(5, 99.8, 100, 99.7, 99.9, 100),
    ]
    breakout = strategy_bar(6, 99.9, 101.2, 99.8, 101, 250)
    captured_quote = quote().model_copy(
        update={"timestamp": breakout.end, "last": breakout.close, "day_high": breakout.high}
    )
    result = replay(
        BacktestReplayRequest(
            run_id=RUN_ID,
            config_version="phase11-replay",
            strategies=["HIGH_OF_DAY_BREAKOUT"],
            assumptions=BacktestAssumptions(
                starting_capital=100_000, position_size=10_000, slippage_bps=0, fee_per_trade=0
            ),
            sessions=[
                BacktestSession(
                    session=session(),
                    candles=[*daily_history(), *minute_history(), *base, breakout],
                    quotes=[captured_quote],
                )
            ],
        )
    )
    assert {value.strategy for value in result.timeline} == {"HIGH_OF_DAY_BREAKOUT"}
    assert any(value.state == "READY" for value in result.timeline)


def test_signal_replay_returns_full_events_without_invoking_fill_simulation() -> None:
    base = [
        strategy_bar(3, 99.5, 99.9, 99.4, 99.8, 100),
        strategy_bar(4, 99.7, 99.95, 99.6, 99.85, 100),
        strategy_bar(5, 99.8, 100, 99.7, 99.9, 100),
    ]
    breakout = strategy_bar(6, 99.9, 101.2, 99.8, 101, 250)
    captured_quote = quote().model_copy(
        update={"timestamp": breakout.end, "last": breakout.close, "day_high": breakout.high}
    )
    result = replay_signals(
        BacktestReplayRequest(
            run_id=RUN_ID,
            config_version="signal-only",
            strategies=["HIGH_OF_DAY_BREAKOUT"],
            assumptions=BacktestAssumptions(
                starting_capital=100_000, position_size=10_000, slippage_bps=0, fee_per_trade=0
            ),
            sessions=[
                BacktestSession(
                    session=session(),
                    candles=[*daily_history(), *minute_history(), *base, breakout],
                    quotes=[captured_quote],
                )
            ],
        )
    )
    ready = next(value for value in result.events if value.state == "READY")
    assert ready.entry_reference is not None
    assert ready.feature_snapshot.atr_14 is not None
    assert result.data_quality.sessions == 1


def test_signal_replay_accepts_a_market_bound_us_session() -> None:
    us_session = session().model_copy(
        update={
            "market_id": "US_EQUITIES",
            "market": "US",
            "timezone": "America/New_York",
        }
    )
    result = replay_signals(
        BacktestReplayRequest(
            run_id=RUN_ID,
            market_id="US_EQUITIES",
            config_version="us-replay",
            strategies=["ORB_RETEST"],
            assumptions=BacktestAssumptions(
                starting_capital=100_000, position_size=10_000, slippage_bps=10, fee_per_trade=0
            ),
            sessions=[BacktestSession(session=us_session, candles=[], quotes=[])],
        )
    )
    assert result.events == []
    assert result.data_quality.quote_snapshots == 0


def test_signal_replay_rejects_a_session_from_another_market() -> None:
    with pytest.raises(ValueError, match="does not match session market"):
        replay_signals(
            BacktestReplayRequest(
                run_id=RUN_ID,
                market_id="US_EQUITIES",
                config_version="us-replay",
                strategies=["ORB_RETEST"],
                assumptions=BacktestAssumptions(
                    starting_capital=100_000, position_size=10_000, slippage_bps=10, fee_per_trade=0
                ),
                sessions=[BacktestSession(session=session(), candles=[], quotes=[])],
            )
        )


def test_execution_ignores_the_partially_elapsed_signal_bar() -> None:
    signal_time = datetime(2026, 8, 25, 14, 0, 30, tzinfo=UTC)
    event = StrategyStateEvent.model_construct(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        strategy="ORB_RETEST",
        strategy_version="1.0.0",
        timestamp=signal_time,
        score=85,
        state="READY",
        entry_reference=10,
        stop_reference=9.5,
        target_reference=11,
        reason_codes=[],
    )
    overlapping = CandleRecord(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        timeframe="OneMinute",
        start=signal_time - timedelta(seconds=30),
        end=signal_time + timedelta(seconds=30),
        open=10,
        high=10.1,
        low=9.4,
        close=10,
        volume=100,
        is_complete=True,
    )
    later = overlapping.model_copy(
        update={
            "start": signal_time + timedelta(seconds=30),
            "end": signal_time + timedelta(seconds=90),
            "high": 11.1,
            "low": 9.9,
            "close": 11,
        }
    )
    request = BacktestReplayRequest(
        run_id=RUN_ID,
        config_version="test-v1",
        strategies=["ORB_RETEST"],
        assumptions=BacktestAssumptions(starting_capital=100_000, position_size=1_000, slippage_bps=0, fee_per_trade=0),
        sessions=[],
    )
    result = _simulate_trades(request, [event], [(signal_time.replace(hour=13, minute=30), [overlapping, later])])
    assert result[0].exit_reason == "TARGET"


def test_replay_counts_and_simulates_one_trade_per_setup_instance() -> None:
    signal_time = datetime(2026, 8, 25, 14, tzinfo=UTC)
    setup_id = UUID("10000000-0000-4000-8000-000000000099")
    event = StrategyStateEvent.model_construct(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        strategy="ORB_RETEST",
        strategy_version="1.0.0",
        timestamp=signal_time,
        score=85,
        state="READY",
        entry_reference=10,
        stop_reference=9.5,
        target_reference=11,
        reason_codes=[],
        setup_instance_id=setup_id,
    )
    repeated = event.model_copy(update={"timestamp": signal_time + timedelta(seconds=1)})
    bar = CandleRecord(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        timeframe="OneMinute",
        start=signal_time,
        end=signal_time + timedelta(minutes=1),
        open=10,
        high=11.1,
        low=9.9,
        close=11,
        volume=100,
        is_complete=True,
    )
    request = BacktestReplayRequest(
        run_id=RUN_ID,
        config_version="test-v1",
        strategies=["ORB_RETEST"],
        assumptions=BacktestAssumptions(starting_capital=100_000, position_size=1_000, slippage_bps=0, fee_per_trade=0),
        sessions=[],
    )
    trades = _simulate_trades(request, [event, repeated], [(signal_time.replace(hour=13, minute=30), [bar])])
    assert len(trades) == 1
    assert trades[0].setup_instance_id == setup_id
    assert _metrics(trades, [event, repeated], 100_000).ready_signals == 1


def test_calibration_can_use_atr_stop_and_fixed_reward_risk_without_structural_levels() -> None:
    signal_time = datetime(2026, 8, 25, 14, tzinfo=UTC)
    event = StrategyStateEvent.model_construct(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        strategy="ORB_RETEST",
        strategy_version="1.0.0",
        timestamp=signal_time,
        score=85,
        state="READY",
        entry_reference=10,
        stop_reference=None,
        target_reference=None,
        reason_codes=[],
        feature_snapshot=SimpleNamespace(atr_14=0.5, atr_pct=5, rvol_at_time=2),
    )
    bar = CandleRecord(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        timeframe="OneMinute",
        start=signal_time,
        end=signal_time + timedelta(minutes=1),
        open=10,
        high=11.1,
        low=9.9,
        close=11,
        volume=100,
        is_complete=True,
    )
    request = BacktestReplayRequest(
        run_id=RUN_ID,
        config_version="calibration-v1",
        strategies=["ORB_RETEST"],
        assumptions=BacktestAssumptions(
            starting_capital=100_000,
            position_size=1_000,
            slippage_bps=0,
            fee_per_trade=0,
            stop_method="ATR",
            atr_stop_multiple=1,
            reward_risk_ratio=2,
        ),
        sessions=[],
    )
    result = _simulate_trades(request, [event], [(signal_time.replace(hour=13, minute=30), [bar])])
    assert result[0].stop_price == 9.5
    assert result[0].target_price == 11
    assert result[0].exit_reason == "TARGET"


def test_simulate_trades_gap_below_stop_fills_at_open() -> None:
    signal_time = datetime(2026, 8, 25, 14, tzinfo=UTC)
    event = StrategyStateEvent.model_construct(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        strategy="ORB_RETEST",
        strategy_version="1.0.0",
        timestamp=signal_time,
        score=85,
        state="READY",
        entry_reference=10,
        stop_reference=9.5,
        target_reference=11,
        reason_codes=[],
    )
    # Candle opens below the $9.50 stop at $8.00
    gap_bar = CandleRecord(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        timeframe="OneMinute",
        start=signal_time,
        end=signal_time + timedelta(minutes=1),
        open=8.0,
        high=8.5,
        low=7.5,
        close=8.0,
        volume=100,
        is_complete=True,
    )
    request = BacktestReplayRequest(
        run_id=RUN_ID,
        config_version="gap-test",
        strategies=["ORB_RETEST"],
        assumptions=BacktestAssumptions(
            starting_capital=100_000,
            position_size=1_000,
            slippage_bps=0,
            fee_per_trade=0,
        ),
        sessions=[],
    )
    result = _simulate_trades(request, [event], [(signal_time.replace(hour=13, minute=30), [gap_bar])])
    assert len(result) == 1
    assert result[0].exit_reason == "STOP"
    assert result[0].exit_price == 8.0
