from datetime import timedelta

from app.strategy_engine import StrategyEngine
from test_feature_engine import INSTRUMENT_ID, SESSION_START, five_minute_history, quote, session, warmed_engine
from app.models import CandleRecord, ScannerProfileConfig, StrategyParameters
from uuid import UUID


def bar(index: int, open_: float, high: float, low: float, close: float, volume: int) -> CandleRecord:
    start = SESSION_START + timedelta(minutes=index * 5)
    return CandleRecord(instrument_id=INSTRUMENT_ID, symbol="TEST.TO", timeframe="FiveMinutes", start=start,
                        end=start + timedelta(minutes=5), open=open_, high=high, low=low, close=close,
                        volume=volume, is_complete=True)


def test_orb_replay_has_explainable_forming_then_ready_transitions() -> None:
    feature_engine = warmed_engine()
    snapshot = feature_engine.ingest_quotes([quote()])[0]
    assert snapshot.opening_range is not None
    orh = snapshot.opening_range.high
    base = [bar(3, orh - .1, orh, orh - .2, orh - .05, 100), bar(4, orh - .05, orh, orh - .1, orh, 100), bar(5, orh, orh + .02, orh - .05, orh, 100)]
    breakout = bar(6, orh, orh + .3, orh, orh + .2, 200)
    retest = bar(7, orh + .2, orh + .25, orh - .05, orh + .05, 120)
    engine = StrategyEngine()

    forming_snapshot = snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close})
    evaluations, events, _ = engine.evaluate(forming_snapshot, [*base, breakout])
    orb = next(value for value in evaluations if value.strategy == "ORB_RETEST")
    assert orb.state == "FORMING"
    assert "ORB_BREAKOUT_CONFIRMED" in orb.reason_codes
    assert next(value for value in events if value.strategy == "ORB_RETEST").previous_state == "INACTIVE"

    ready_snapshot = snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close})
    evaluations, events, _ = engine.evaluate(ready_snapshot, [*base, breakout, retest])
    orb = next(value for value in evaluations if value.strategy == "ORB_RETEST")
    assert orb.state == "READY"
    assert "ORB_RETEST_CONFIRMED" in orb.reason_codes
    assert next(value for value in events if value.strategy == "ORB_RETEST").previous_state == "FORMING"


def test_delayed_data_hard_gates_ready_regardless_of_score() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0].model_copy(update={"actionable": False, "data_status": "DELAYED"})
    evaluations, _, _ = StrategyEngine().evaluate(snapshot, five_minute_history())
    assert {value.state for value in evaluations} == {"DATA_STALE"}
    assert all(value.score < 60 and "DATA_STALE" in value.reason_codes for value in evaluations)


def test_same_replay_is_deterministic() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    first = StrategyEngine().evaluate(snapshot, five_minute_history())[0]
    second = StrategyEngine().evaluate(snapshot, five_minute_history())[0]
    assert [value.model_dump(exclude={"feature_snapshot"}) for value in first] == [value.model_dump(exclude={"feature_snapshot"}) for value in second]


def test_one_snapshot_fans_out_to_two_parameterizations_of_same_strategy() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    standard = ScannerProfileConfig(profile_id=UUID("10000000-0000-4000-8000-000000000081"), profile_name="ORB Standard", strategy="ORB_RETEST", config_version="standard", parameters=StrategyParameters(rvol_at_time_min=1.5))
    strict = ScannerProfileConfig(profile_id=UUID("10000000-0000-4000-8000-000000000083"), profile_name="ORB Strict", strategy="ORB_RETEST", config_version="strict", parameters=StrategyParameters(rvol_at_time_min=20), display_order=1)
    engine = StrategyEngine()
    engine.configure_profiles([standard, strict])
    evaluations, _, _ = engine.evaluate(snapshot, five_minute_history())
    assert [value.profile_name for value in evaluations] == ["ORB Standard", "ORB Strict"]
    assert evaluations[0].state != "INACTIVE"
    assert evaluations[1].state == "INACTIVE"
    assert evaluations[0].feature_snapshot == evaluations[1].feature_snapshot == snapshot


def test_calibrated_atr_threshold_is_a_hard_candidate_gate() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    profile = ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-000000000084"), profile_name="ATR Strict",
        strategy="ORB_RETEST", config_version="atr-strict",
        parameters=StrategyParameters(atr_pct_min=20),
    )
    engine = StrategyEngine()
    engine.configure_profiles([profile])
    evaluation = engine.evaluate(snapshot, five_minute_history())[0][0]
    assert evaluation.state == "INACTIVE"
    assert "ATR_BELOW_MINIMUM" in evaluation.reason_codes


def test_ready_remains_eligible_after_noon_and_expires_at_market_close() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    assert snapshot.opening_range is not None
    orh = snapshot.opening_range.high
    baseline = [bar(0, orh - .1, orh, orh - .2, orh - .05, 100),
                bar(1, orh - .05, orh, orh - .1, orh, 100),
                bar(2, orh, orh + .02, orh - .05, orh, 100)]
    breakout = bar(3, orh, orh + .3, orh, orh + .2, 200)
    retest = bar(4, orh + .2, orh + .25, orh - .05, orh + .05, 120)
    engine = StrategyEngine()
    engine.start_session(session())
    engine.evaluate(snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}), [*baseline, breakout])

    before = engine.evaluate(snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}), [*baseline, breakout, retest])[0]
    orb = next(value for value in before if value.strategy == "ORB_RETEST")
    assert orb.state == "FORMING"
    assert "WAITING_FOR_PREFERRED_ENTRY_WINDOW" in orb.reason_codes

    at_preferred = engine.evaluate(snapshot.model_copy(update={"timestamp": SESSION_START + timedelta(minutes=30), "price": retest.close}), [*baseline, breakout, retest])[0]
    orb = next(value for value in at_preferred if value.strategy == "ORB_RETEST")
    assert orb.state == "READY"
    assert "PREFERRED_ENTRY_WINDOW" in orb.reason_codes

    after_noon = engine.evaluate(snapshot.model_copy(update={"timestamp": SESSION_START + timedelta(hours=3), "price": retest.close}), [*baseline, breakout, retest])[0]
    orb = next(value for value in after_noon if value.strategy == "ORB_RETEST")
    assert orb.state == "READY"
    assert "OUTSIDE_PREFERRED_ENTRY_WINDOW" in orb.reason_codes

    at_hard_end = engine.evaluate(snapshot.model_copy(update={"timestamp": SESSION_START + timedelta(hours=6, minutes=30), "price": retest.close}), [*baseline, breakout, retest])[0]
    assert {value.state for value in at_hard_end} == {"EXPIRED"}
    assert all("NEW_ENTRY_WINDOW_CLOSED" in value.reason_codes for value in at_hard_end)


def test_stop_policy_selection() -> None:
    from app.models import FeatureLevel
    from app.strategies.base import BaseStrategy, StrategyContext, StrategyMemory

    strategy = BaseStrategy()
    memory = StrategyMemory(state="READY", stop_level=9.50)

    # FeatureSnapshot has price=10.00, nearest_support at 9.80 (higher than pattern stop 9.50)
    snapshot = warmed_engine().ingest_quotes([quote()])[0].model_copy(
        update={
            "price": 10.00,
            "nearest_support": FeatureLevel(price=9.80, type="CONFIRMED_PIVOT", strength=1.0, tests=2, age_bars=5),
        }
    )
    context = StrategyContext(bars=[])

    # 1. HYBRID (default): chooses max(9.50, 9.80) = 9.80
    _, stop_hybrid, _ = strategy.trade_references(
        memory, snapshot, context, "READY", StrategyParameters(stop_policy="HYBRID")
    )
    assert stop_hybrid == 9.80
    assert memory.selected_stop_level == 9.80
    assert memory.stop_policy == "HYBRID"

    # 2. PATTERN_INVALIDATION: preserves structural pattern stop 9.50
    _, stop_pattern, _ = strategy.trade_references(
        memory, snapshot, context, "READY", StrategyParameters(stop_policy="PATTERN_INVALIDATION")
    )
    assert stop_pattern == 9.50
    assert memory.selected_stop_level == 9.50
    assert memory.stop_policy == "PATTERN_INVALIDATION"

    # 3. NEAREST_SUPPORT: chooses nearest support 9.80
    _, stop_support, _ = strategy.trade_references(
        memory, snapshot, context, "READY", StrategyParameters(stop_policy="NEAREST_SUPPORT")
    )
    assert stop_support == 9.80
    assert memory.selected_stop_level == 9.80
    assert memory.stop_policy == "NEAREST_SUPPORT"
