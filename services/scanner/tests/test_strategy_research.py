from datetime import timedelta
from uuid import UUID

from app.feature_engine import FeatureEngine
from app.feature_indicators import candle_quality, daily_ema_context, is_rejection_candle, volume_contraction_ratio, wilder_rsi
from app.models import CandleRecord, ScannerProfileConfig, StrategyParameters
from app.strategies.base import StrategyContext
from app.strategy_engine import StrategyEngine
from test_feature_engine import INSTRUMENT_ID, SESSION_START, quote, session, warmed_engine
from test_strategy_engine import bar


def test_wilder_rsi_documents_flat_gain_and_loss_edges() -> None:
    assert wilder_rsi([100] * 15, 14)[-1] == 50
    assert wilder_rsi(list(range(100, 116)), 14)[-1] == 100
    assert wilder_rsi(list(range(116, 100, -1)), 14)[-1] == 0
    assert wilder_rsi([100] * 14, 14)[-1] is None


def test_wilder_rsi_prefix_is_invariant_to_a_future_suffix() -> None:
    prefix = [100, 100.5, 100.25, 100.75, 101, 100.8, 101.2, 101.1, 101.4, 101.6, 101.2, 101.5, 101.7, 101.8, 102]
    suffix = [101.5, 101.9, 102.2]
    assert wilder_rsi(prefix) == wilder_rsi(prefix + suffix)[: len(prefix)]


def test_rejection_geometry_excludes_zero_range_and_zero_body_candles() -> None:
    zero_range = bar(0, 100, 100, 100, 100, 100)
    doji = bar(1, 100, 101, 99, 100, 100)
    hammer = bar(2, 100.1, 100.21, 99.8, 100.2, 100)

    assert candle_quality(zero_range).close_location is None
    assert not is_rejection_candle(zero_range, 100)
    assert not is_rejection_candle(doji, 100)
    assert is_rejection_candle(hammer, 100)
    assert volume_contraction_ratio([], [hammer]) is None
    assert volume_contraction_ratio([hammer], [zero_range.model_copy(update={"volume": 0})]) is None


def test_daily_ema_context_requires_completed_history_and_slopes() -> None:
    history = [
        CandleRecord(
            instrument_id=INSTRUMENT_ID,
            symbol="TEST.TO",
            timeframe="OneDay",
            start=SESSION_START - timedelta(days=40 - index),
            end=SESSION_START - timedelta(days=40 - index) + timedelta(hours=6),
            open=100 + index,
            high=101 + index,
            low=99 + index,
            close=100.5 + index,
            volume=1_000,
            is_complete=True,
        )
        for index in range(25)
    ]
    context = daily_ema_context(history)
    assert context.status == "BULLISH"
    assert context.ema13 is not None and context.ema21 is not None
    assert context.slope13 is not None and context.slope13 > 0
    assert daily_ema_context(history[:21]).status == "UNAVAILABLE"
    incomplete = history[-1].model_copy(update={"is_complete": False})
    with_incomplete = daily_ema_context([*history, incomplete])
    assert with_incomplete.status == context.status
    assert with_incomplete.source_timestamp == context.source_timestamp


def test_feature_engine_carries_regular_session_rsi_warmup_across_sessions() -> None:
    historical = [
        bar_for_time(
            SESSION_START - timedelta(days=day) + timedelta(minutes=index * 5),
            100 + day + index * 0.1,
            100,
        )
        for day in range(3, 0, -1)
        for index in range(6)
    ]
    engine = FeatureEngine()
    engine.start_session(session())
    engine.ingest_candles([*historical, bar_for_time(SESSION_START, 102, 100)])
    snapshot = engine.ingest_quotes([quote()])[0]
    context = engine.strategy_context(snapshot)

    assert snapshot.rsi_14 is not None
    assert snapshot.rsi_timestamp == SESSION_START + timedelta(minutes=5)
    assert context.rsi_by_bar is not None and len(context.rsi_by_bar) >= 5


def bar_for_time(start, close: float, volume: int) -> CandleRecord:
    return CandleRecord(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        timeframe="FiveMinutes",
        start=start,
        end=start + timedelta(minutes=5),
        open=close - 0.1,
        high=close + 0.1,
        low=close - 0.2,
        close=close,
        volume=volume,
        is_complete=True,
    )


def _profile(strategy: str, **parameters: int | float) -> ScannerProfileConfig:
    return ScannerProfileConfig(
        profile_id=UUID("30000000-0000-4000-8000-000000000001"),
        profile_name=strategy,
        strategy=strategy,
        config_version="research-test-v1",
        parameters=StrategyParameters(**parameters),
    )


def test_orb_high_break_variant_waits_for_later_confirmation() -> None:
    feature_engine = warmed_engine()
    snapshot = feature_engine.ingest_quotes([quote()])[0]
    assert snapshot.opening_range is not None
    level = snapshot.opening_range.high
    base = [
        bar(3, level - 0.1, level, level - 0.2, level - 0.05, 100),
        bar(4, level - 0.05, level, level - 0.1, level, 100),
        bar(5, level, level + 0.02, level - 0.05, level, 100),
    ]
    breakout = bar(6, level, level + 0.3, level, level + 0.2, 200)
    retest = bar(7, level + 0.2, level + 0.25, level - 0.05, level + 0.05, 120)
    confirmation = bar(8, retest.close, retest.high + 0.3, retest.close, retest.high + 0.2, 140)
    engine = StrategyEngine()
    engine.configure_profiles([_profile("ORB_RETEST", retest_high_break_enabled=1)])

    first = engine.evaluate(snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}), [*base, breakout])[0][0]
    pending = engine.evaluate(snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}), [*base, breakout, retest])[0][0]
    ready = engine.evaluate(snapshot.model_copy(update={"timestamp": confirmation.end, "price": confirmation.close}), [*base, breakout, retest, confirmation])[0][0]

    assert first.state == "FORMING"
    assert pending.state == "FORMING"
    assert "RETEST_HIGH_BREAK_PENDING" in pending.reason_codes
    assert ready.state == "READY"


def test_disabled_retest_options_keep_baseline_ready_semantics() -> None:
    feature_engine = warmed_engine()
    snapshot = feature_engine.ingest_quotes([quote()])[0]
    assert snapshot.opening_range is not None
    level = snapshot.opening_range.high
    base = [
        bar(3, level - 0.1, level, level - 0.2, level - 0.05, 100),
        bar(4, level - 0.05, level, level - 0.1, level, 100),
        bar(5, level, level + 0.02, level - 0.05, level, 100),
    ]
    breakout = bar(6, level, level + 0.3, level, level + 0.2, 200)
    retest = bar(7, level + 0.2, level + 0.25, level - 0.05, level + 0.05, 120)

    engine = StrategyEngine()
    engine.configure_profiles([_profile("ORB_RETEST")])
    engine.evaluate(snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}), [*base, breakout])
    result = engine.evaluate(snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}), [*base, breakout, retest])[0][0]

    assert result.state == "READY"
    assert "RETEST_VOLUME_CONTRACTED" not in result.reason_codes
    assert "RETEST_HIGH_BREAK_PENDING" not in result.reason_codes


def test_vwap_volume_variant_preserves_later_baseline_hold_confirmation() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    support = 100.0
    impulse = [
        bar(3, 100.6, 100.9, 100.5, 100.8, 100),
        bar(4, 100.8, 101.1, 100.7, 101.0, 100),
        bar(5, 101.0, 101.3, 100.9, 101.2, 100),
    ]
    touch = bar(6, 101.2, 101.3, 99.9, 100.1, 50)
    hold = bar(7, 100.1, 101.2, 100.05, 101.0, 100)
    engine = StrategyEngine()
    engine.configure_profiles([_profile("VWAP_HOLD", retest_volume_contraction_enabled=1)])

    def evaluate(candle: CandleRecord, history: list[CandleRecord]):
        return engine.evaluate(
            snapshot.model_copy(
                update={
                    "timestamp": candle.end,
                    "price": candle.close,
                    "vwap": support,
                    "completed_bar_vwap": support,
                    "close_above_vwap": True,
                    "last_3_closes_above_vwap": 3,
                }
            ),
            history,
        )[0][0]

    pending = evaluate(touch, [*impulse, touch])
    ready = evaluate(hold, [*impulse, touch, hold])

    assert pending.state == "FORMING"
    assert "VWAP_HOLD_IN_PROGRESS" in pending.reason_codes
    assert "RETEST_VOLUME_CONTRACTED" in pending.reason_codes
    assert ready.state == "READY"


def test_vwap_volume_rejection_retains_bound_formation_evidence() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    support = 100.0
    impulse = [
        bar(3, 100.6, 100.9, 100.5, 100.8, 100),
        bar(4, 100.8, 101.1, 100.7, 101.0, 100),
        bar(5, 101.0, 101.3, 100.9, 101.2, 100),
    ]
    rejected_touch = bar(6, 101.2, 101.3, 99.9, 100.1, 100)
    engine = StrategyEngine()
    engine.configure_profiles([_profile("VWAP_HOLD", retest_volume_contraction_enabled=1)])

    evaluations, events, _ = engine.evaluate(
        snapshot.model_copy(
            update={
                "timestamp": rejected_touch.end,
                "price": rejected_touch.close,
                "vwap": support,
                "completed_bar_vwap": support,
                "close_above_vwap": True,
                "last_3_closes_above_vwap": 3,
            }
        ),
        [*impulse, rejected_touch],
    )
    rejected = evaluations[0]

    assert rejected.state == "INVALIDATED"
    assert rejected.setup_instance_id is not None
    assert rejected.formation_evidence is not None
    assert rejected.formation_evidence.retest is not None
    assert rejected.formation_evidence.retest.volume_contraction_ratio == 1.0
    assert len(events) == 1
    assert events[0].setup_instance_id == rejected.setup_instance_id
    assert events[0].formation_evidence == rejected.formation_evidence


def test_retest_volume_uses_bound_pullback_window_and_is_independent() -> None:
    feature_engine = warmed_engine()
    snapshot = feature_engine.ingest_quotes([quote()])[0]
    assert snapshot.opening_range is not None
    level = snapshot.opening_range.high
    base = [
        bar(3, level - 0.1, level, level - 0.2, level - 0.05, 100),
        bar(4, level - 0.05, level, level - 0.1, level, 100),
        bar(5, level, level + 0.02, level - 0.05, level, 100),
    ]
    breakout = bar(6, level, level + 0.3, level, level + 0.2, 200)
    quiet_retest = bar(7, level + 0.2, level + 0.25, level - 0.05, level + 0.05, 120)
    loud_retest = quiet_retest.model_copy(update={"volume": 200})

    def evaluate(retest: CandleRecord):
        engine = StrategyEngine()
        engine.configure_profiles([_profile("ORB_RETEST", retest_volume_contraction_enabled=1)])
        engine.evaluate(
            snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}),
            [*base, breakout],
        )
        evaluations, events, _ = engine.evaluate(
            snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}),
            [*base, breakout, retest],
        )
        return evaluations[0], events

    quiet, _ = evaluate(quiet_retest)
    loud, loud_events = evaluate(loud_retest)
    assert quiet.state == "READY"
    assert "RETEST_VOLUME_CONTRACTED" in quiet.reason_codes
    assert loud.state == "INVALIDATED"
    assert "RETEST_VOLUME_NOT_CONTRACTED" in loud.reason_codes
    assert loud.setup_instance_id is not None
    assert loud.formation_evidence is not None
    assert loud.formation_evidence.retest is not None
    assert loud.formation_evidence.retest.volume_contraction_ratio == 1.0
    assert len(loud_events) == 1
    assert loud_events[0].formation_evidence == loud.formation_evidence


def test_orb_volume_variant_ready_is_stable_across_identical_rescans() -> None:
    feature_engine = warmed_engine()
    snapshot = feature_engine.ingest_quotes([quote()])[0]
    assert snapshot.opening_range is not None
    level = snapshot.opening_range.high
    base = [
        bar(3, level - 0.1, level, level - 0.2, level - 0.05, 100),
        bar(4, level - 0.05, level, level - 0.1, level, 100),
        bar(5, level, level + 0.02, level - 0.05, level, 100),
    ]
    breakout = bar(6, level, level + 0.3, level, level + 0.2, 200)
    retest = bar(7, level + 0.2, level + 0.25, level - 0.05, level + 0.05, 120)
    engine = StrategyEngine()
    engine.configure_profiles([_profile("ORB_RETEST", retest_volume_contraction_enabled=1)])

    engine.evaluate(
        snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}),
        [*base, breakout],
    )
    ready, ready_events, _ = engine.evaluate(
        snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}),
        [*base, breakout, retest],
    )
    repeated, repeated_events, _ = engine.evaluate(
        snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}),
        [*base, breakout, retest],
    )

    assert ready[0].state == "READY"
    assert len(ready_events) == 1
    assert repeated[0].state == "READY"
    assert repeated_events == []


def test_retest_rejection_can_confirm_without_enabling_high_break() -> None:
    feature_engine = warmed_engine()
    snapshot = feature_engine.ingest_quotes([quote()])[0]
    assert snapshot.opening_range is not None
    level = snapshot.opening_range.high
    base = [
        bar(3, level - 0.1, level, level - 0.2, level - 0.05, 100),
        bar(4, level - 0.05, level, level - 0.1, level, 100),
        bar(5, level, level + 0.02, level - 0.05, level, 100),
    ]
    breakout = bar(6, level, level + 0.3, level, level + 0.2, 200)
    rejection = bar(7, level + 0.2, level + 0.26, level - 0.1, level + 0.24, 120)
    confirmation = bar(8, level + 0.24, level + 0.28, level + 0.1, level + 0.2, 120)
    engine = StrategyEngine()
    engine.configure_profiles([_profile("ORB_RETEST", retest_rejection_enabled=1)])

    engine.evaluate(
        snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}),
        [*base, breakout],
    )
    pending = engine.evaluate(
        snapshot.model_copy(update={"timestamp": rejection.end, "price": rejection.close}),
        [*base, breakout, rejection],
    )[0][0]
    ready = engine.evaluate(
        snapshot.model_copy(update={"timestamp": confirmation.end, "price": confirmation.close}),
        [*base, breakout, rejection, confirmation],
    )[0][0]

    assert pending.state == "FORMING"
    assert "SUPPORT_REJECTION_CONFIRMED" in pending.reason_codes
    assert "RETEST_HIGH_BREAK_PENDING" not in pending.reason_codes
    assert ready.state == "READY"


def _rsi_bars() -> list[CandleRecord]:
    lows = [100, 99.5, 98, 99, 100, 99.5, 99, 97.5, 98.5, 99.5, 100, 100.2, 100.5]
    closes = [low + 0.5 for low in lows]
    volumes = [100, 100, 100, 100, 100, 50, 50, 50, 100, 100, 100, 100, 100]
    return [bar(index, closes[index] - 0.2, closes[index] + 0.2, lows[index], closes[index], volumes[index]) for index in range(len(lows))]


def test_rsi_vwap_reclaim_requires_ordered_divergence_reclaim_hold_and_break() -> None:
    bars = _rsi_bars()
    rsi_values = {bars[2].end: 40.0, bars[7].end: 45.0}
    context = StrategyContext(bars=bars, rsi_by_bar=rsi_values, indicator_version="wilder-rsi-14-v1")
    feature_engine = warmed_engine()
    base_snapshot = feature_engine.ingest_quotes([quote()])[0]
    engine = StrategyEngine()
    engine.configure_profiles([_profile("RSI_VWAP_RECLAIM", rvol_at_time_min=0, atr_pct_min=0)])

    divergence = engine.evaluate(base_snapshot.model_copy(update={"timestamp": bars[9].end, "price": bars[9].close}), context)[0][0]
    early_reclaim = engine.evaluate(
        base_snapshot.model_copy(update={"timestamp": bars[7].end, "price": bars[7].close, "vwap_reclaim": True, "completed_bar_vwap": 100.0}),
        context,
    )[0][0]
    assert divergence.state == "FORMING"
    assert "RSI_BULLISH_DIVERGENCE_CONFIRMED" in divergence.reason_codes
    assert early_reclaim.state == "FORMING"
    assert "RSI_VWAP_RECLAIM_PENDING" in early_reclaim.reason_codes

    reclaim = bars[10]
    reclaim_context = StrategyContext(bars=bars[:11], rsi_by_bar=rsi_values, indicator_version="wilder-rsi-14-v1")
    reclaimed = engine.evaluate(
        base_snapshot.model_copy(update={"timestamp": reclaim.end, "price": reclaim.close, "vwap_reclaim": True, "completed_bar_vwap": 100.0}),
        reclaim_context,
    )[0][0]
    hold = bars[11]
    held = engine.evaluate(
        base_snapshot.model_copy(update={"timestamp": hold.end, "price": hold.close, "completed_bar_vwap": 100.0}),
        StrategyContext(bars=bars[:12], rsi_by_bar=rsi_values, indicator_version="wilder-rsi-14-v1"),
    )[0][0]
    broken = bars[12]
    ready, ready_events, _ = engine.evaluate(
        base_snapshot.model_copy(update={"timestamp": broken.end, "price": broken.close, "completed_bar_vwap": 100.0}),
        StrategyContext(bars=bars, rsi_by_bar=rsi_values, indicator_version="wilder-rsi-14-v1"),
    )
    ready = ready[0]

    assert reclaimed.state == "FORMING" and "RSI_VWAP_RECLAIM_CONFIRMED" in reclaimed.reason_codes
    assert held.state == "FORMING" and "RSI_VWAP_HOLD_CONFIRMED" in held.reason_codes
    assert ready.state == "READY"
    assert "RSI_RESISTANCE_BREAK_CONFIRMED" in ready.reason_codes
    assert ready.stop_reference is not None and ready.stop_reference < bars[7].low
    evidence = ready.formation_evidence
    assert evidence is not None and evidence.version == "formation-evidence-v1"
    assert evidence.rsi_vwap_reclaim is not None
    assert evidence.rsi_vwap_reclaim.first_pivot.rsi == 40.0
    assert evidence.rsi_vwap_reclaim.second_pivot.rsi == 45.0
    assert evidence.rsi_vwap_reclaim.divergence_volume_contraction_ratio == 0.5
    assert evidence.rsi_vwap_reclaim.frozen_resistance is not None
    assert len(ready_events) == 1
    assert ready_events[0].formation_evidence == evidence


def test_rsi_vwap_hold_rejects_a_low_below_the_downside_tolerance() -> None:
    bars = _rsi_bars()
    rsi_values = {bars[2].end: 40.0, bars[7].end: 45.0}
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    engine = StrategyEngine()
    engine.configure_profiles([_profile("RSI_VWAP_RECLAIM", rvol_at_time_min=0, atr_pct_min=0)])
    engine.evaluate(
        snapshot.model_copy(update={"timestamp": bars[9].end, "price": bars[9].close}),
        StrategyContext(bars=bars, rsi_by_bar=rsi_values, indicator_version="wilder-rsi-14-v1"),
    )
    reclaim = bars[10]
    engine.evaluate(
        snapshot.model_copy(
            update={
                "timestamp": reclaim.end,
                "price": reclaim.close,
                "completed_bar_vwap": 100.0,
                "vwap_reclaim": True,
            }
        ),
        StrategyContext(bars=bars[:11], rsi_by_bar=rsi_values, indicator_version="wilder-rsi-14-v1"),
    )
    deep_dip = bar(11, 100.5, 100.8, 98.0, 100.7, 100)
    held = engine.evaluate(
        snapshot.model_copy(
            update={
                "timestamp": deep_dip.end,
                "price": deep_dip.close,
                "completed_bar_vwap": 100.0,
            }
        ),
        StrategyContext(
            bars=[*bars[:11], deep_dip],
            rsi_by_bar=rsi_values,
            indicator_version="wilder-rsi-14-v1",
        ),
    )[0][0]

    assert held.state == "FORMING"
    assert "RSI_VWAP_HOLD_PENDING" in held.reason_codes
    assert "RSI_VWAP_HOLD_CONFIRMED" not in held.reason_codes


def test_rsi_invalidation_precedes_same_bar_advancement() -> None:
    bars = _rsi_bars()
    rsi_values = {bars[2].end: 40.0, bars[7].end: 45.0}
    engine = StrategyEngine()
    engine.configure_profiles([_profile("RSI_VWAP_RECLAIM", rvol_at_time_min=0)])
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    context = StrategyContext(bars=bars, rsi_by_bar=rsi_values, indicator_version="wilder-rsi-14-v1")
    engine.evaluate(snapshot.model_copy(update={"timestamp": bars[9].end, "price": bars[9].close}), context)
    failed = bar(13, bars[-1].close, bars[-1].close + 0.1, bars[7].low - 0.2, bars[7].low - 0.1, 100)
    result = engine.evaluate(
        snapshot.model_copy(update={"timestamp": failed.end, "price": failed.close, "completed_bar_vwap": 100.0, "vwap_reclaim": True}),
        StrategyContext(bars=[*bars, failed], rsi_by_bar=rsi_values, indicator_version="wilder-rsi-14-v1"),
    )[0][0]
    assert result.state == "INVALIDATED"
    assert "RSI_DIVERGENCE_INVALIDATED" in result.reason_codes
