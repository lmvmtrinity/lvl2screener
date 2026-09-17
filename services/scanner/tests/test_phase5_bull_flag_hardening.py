from datetime import timedelta
from uuid import UUID

from app.models import CandleRecord, EntryWindow, ScannerProfileConfig, StrategyParameters
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, session, warmed_engine
from test_strategy_engine import bar


def _flag_bars() -> list[CandleRecord]:
    return [
        bar(0, 100, 100.8, 99.8, 100.7, 900),
        bar(1, 100.7, 101.8, 100.6, 101.6, 1_000),
        bar(2, 101.6, 102.6, 101.5, 102.4, 1_100),
        bar(3, 102.4, 102.55, 101.9, 102.1, 400),
        bar(4, 102.1, 102.35, 101.95, 102.2, 350),
    ]


def _breakout_bar() -> CandleRecord:
    return bar(5, 102.2, 103.2, 102.1, 103, 1_100)


def _snapshot(timestamp, price: float, **updates):
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    return snapshot.model_copy(update={"timestamp": timestamp, "price": price, **updates})


def _profile(**parameters) -> ScannerProfileConfig:
    return ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000e1"), profile_name="Bull Flag Test",
        strategy="BULL_FLAG", config_version="phase5-bull-flag-test", parameters=StrategyParameters(**parameters),
    )


def _run_to_ready(engine: StrategyEngine, flag: list[CandleRecord], breakout: CandleRecord):
    engine.evaluate(_snapshot(flag[-1].end, flag[-1].close), flag)
    evaluations = engine.evaluate(_snapshot(breakout.end, breakout.close), [*flag, breakout])[0]
    return next(value for value in evaluations if value.strategy == "BULL_FLAG")


def test_setup_instance_id_is_assigned_at_pullback_and_stable_through_ready() -> None:
    flag = _flag_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    forming = engine.evaluate(_snapshot(flag[-1].end, flag[-1].close), flag)[0]
    flag_forming = next(value for value in forming if value.strategy == "BULL_FLAG")
    assert flag_forming.state == "FORMING"
    assert flag_forming.setup_instance_id is not None

    ready = engine.evaluate(_snapshot(breakout.end, breakout.close), [*flag, breakout])[0]
    flag_ready = next(value for value in ready if value.strategy == "BULL_FLAG")
    assert flag_ready.state == "READY"
    assert flag_ready.setup_instance_id == flag_forming.setup_instance_id


def test_invalidated_setup_rearms_with_a_new_setup_instance_id() -> None:
    flag = _flag_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, flag, breakout)
    first_instance = ready.setup_instance_id
    assert ready.state == "READY" and first_instance is not None

    failure = bar(6, 103, 103.1, 98, 98.2, 100)
    history = [*flag, breakout, failure]
    invalidated = engine.evaluate(_snapshot(failure.end, failure.close), history)[0]
    flag_invalidated = next(value for value in invalidated if value.strategy == "BULL_FLAG")
    assert flag_invalidated.state == "INVALIDATED"
    assert flag_invalidated.setup_instance_id == first_instance

    new_pattern = [
        bar(7, 98.2, 99, 98.1, 98.9, 900), bar(8, 98.9, 99.9, 98.8, 99.8, 1_000), bar(9, 99.8, 100.8, 99.7, 100.6, 1_100),
        bar(10, 100.6, 100.75, 100.1, 100.3, 400), bar(11, 100.3, 100.55, 100.15, 100.4, 350),
        bar(12, 100.4, 100.6, 100.2, 100.5, 300),
    ]
    new_breakout = bar(13, 100.5, 101.6, 100.4, 101.4, 1_300)
    forming_again = engine.evaluate(_snapshot(new_pattern[-1].end, new_pattern[-1].close), [*history, *new_pattern])[0]
    flag_forming_again = next(value for value in forming_again if value.strategy == "BULL_FLAG")
    assert flag_forming_again.state == "FORMING"
    assert flag_forming_again.setup_instance_id is not None
    assert flag_forming_again.setup_instance_id != first_instance

    ready_again = engine.evaluate(_snapshot(new_breakout.end, new_breakout.close), [*history, *new_pattern, new_breakout])[0]
    flag_ready_again = next(value for value in ready_again if value.strategy == "BULL_FLAG")
    assert flag_ready_again.state == "READY"
    assert flag_ready_again.setup_instance_id == flag_forming_again.setup_instance_id


def test_timeout_expires_and_rearms_for_a_later_flag() -> None:
    flag = _flag_bars()
    pending = bar(5, 102.2, 102.4, 102.0, 102.25, 300)
    engine = StrategyEngine()
    engine.configure_profiles([_profile(setup_timeout_minutes=5)])

    engine.evaluate(_snapshot(flag[-1].end, flag[-1].close), flag)
    still_forming = engine.evaluate(_snapshot(pending.end, pending.close), [*flag, pending])[0]
    flag_still_forming = next(value for value in still_forming if value.strategy == "BULL_FLAG")
    assert flag_still_forming.state == "FORMING"

    late = _snapshot(pending.end + timedelta(minutes=2), pending.close)
    expired = engine.evaluate(late, [*flag, pending])[0]
    flag_expired = next(value for value in expired if value.strategy == "BULL_FLAG")
    assert flag_expired.state == "EXPIRED"
    assert "BULL_FLAG_TIMEOUT" in flag_expired.reason_codes
    assert flag_expired.setup_instance_id is not None


def test_daily_reset_clears_memory_and_setup_instance_identity() -> None:
    flag = _flag_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, flag, breakout)
    assert ready.state == "READY" and ready.setup_instance_id is not None

    engine.reset()
    fresh = engine.evaluate(_snapshot(flag[0].end, flag[0].close), flag[:1])[0]
    flag_fresh = next(value for value in fresh if value.strategy == "BULL_FLAG")
    assert flag_fresh.setup_instance_id is None


def test_stale_data_freezes_the_formation_instead_of_discarding_it() -> None:
    flag = _flag_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    forming = engine.evaluate(_snapshot(flag[-1].end, flag[-1].close), flag)[0]
    flag_forming = next(value for value in forming if value.strategy == "BULL_FLAG")
    assert flag_forming.setup_instance_id is not None

    stale = _snapshot(flag[-1].end, flag[-1].close, actionable=False, data_status="DELAYED")
    stalled = engine.evaluate(stale, flag)[0]
    flag_stalled = next(value for value in stalled if value.strategy == "BULL_FLAG")
    assert flag_stalled.state == "DATA_STALE"
    assert flag_stalled.setup_instance_id == flag_forming.setup_instance_id


def test_wide_spread_invalidates_the_formation() -> None:
    flag = _flag_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, flag, breakout)
    assert ready.state == "READY"

    wide = _snapshot(breakout.end, breakout.close, spread_pct=1.0)
    invalidated = engine.evaluate(wide, [*flag, breakout])[0]
    flag_invalidated = next(value for value in invalidated if value.strategy == "BULL_FLAG")
    assert flag_invalidated.state == "INVALIDATED"
    assert "SPREAD_TOO_WIDE" in flag_invalidated.reason_codes


def test_no_signal_session_never_assigns_a_setup_instance() -> None:
    quiet = [bar(0, 100, 100.2, 99.9, 100.1, 100), bar(1, 100.1, 100.3, 100, 100.2, 100),
             bar(2, 100.2, 100.4, 100.1, 100.3, 100), bar(3, 100.3, 100.5, 100.2, 100.4, 100), bar(4, 100.4, 100.6, 100.3, 100.5, 100)]
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    evaluations = engine.evaluate(_snapshot(quiet[-1].end, quiet[-1].close), quiet)[0]
    flag = next(value for value in evaluations if value.strategy == "BULL_FLAG")
    assert flag.state == "WATCH"
    assert flag.setup_instance_id is None


def test_volume_contraction_parameter_rejects_a_flag_that_does_not_contract_enough() -> None:
    flag = _flag_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile(volume_contraction_max_pct=10)])

    forming = engine.evaluate(_snapshot(flag[-1].end, flag[-1].close), flag)[0]
    flag_result = next(value for value in forming if value.strategy == "BULL_FLAG")
    assert flag_result.state == "WATCH"
    assert flag_result.setup_instance_id is None


def test_flag_duration_maximum_forces_a_shorter_flag_window() -> None:
    flag = _flag_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile(flag_duration_bars_max=1)])

    ready = _run_to_ready(engine, flag, breakout)
    assert ready.state in ("READY", "FORMING")


def test_profile_entry_window_overrides_the_session_wide_entry_window() -> None:
    flag = [bar(3, 100, 100.8, 99.8, 100.7, 900), bar(4, 100.7, 101.8, 100.6, 101.6, 1_000), bar(5, 101.6, 102.6, 101.5, 102.4, 1_100),
            bar(6, 102.4, 102.55, 101.9, 102.1, 400), bar(7, 102.1, 102.35, 101.95, 102.2, 350)]
    breakout = bar(8, 102.2, 103.2, 102.1, 103, 1_100)

    default_engine = StrategyEngine()
    default_engine.start_session(session())
    default_engine.configure_profiles([_profile()])
    default_ready = _run_to_ready(default_engine, flag, breakout)
    assert default_ready.state == "READY"

    late_window = EntryWindow(preferred_start="11:00", preferred_end="11:30", hard_end="12:00")
    profile = ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000e2"), profile_name="Bull Flag Late Window",
        strategy="BULL_FLAG", config_version="late-window-v1", entry_window=late_window,
    )
    narrow_engine = StrategyEngine()
    narrow_engine.start_session(session())
    narrow_engine.configure_profiles([profile])
    narrow_result = _run_to_ready(narrow_engine, flag, breakout)
    assert narrow_result.state == "FORMING"
    assert "WAITING_FOR_PREFERRED_ENTRY_WINDOW" in narrow_result.reason_codes


def test_valid_short_flag_remains_detectable_when_earlier_history_prepended() -> None:
    flag = _flag_bars()
    breakout = _breakout_bar()

    engine_clean = StrategyEngine()
    engine_clean.configure_profiles([_profile(flag_duration_bars_min=1, flag_duration_bars_max=4)])
    ready_clean = _run_to_ready(engine_clean, flag, breakout)
    assert ready_clean.state == "READY"

    # Prepend 10 flat bars before bar 0
    prepended = [bar(i - 10, 99, 99.2, 98.8, 99.0, 100) for i in range(10)]
    engine_with_history = StrategyEngine()
    engine_with_history.configure_profiles([_profile(flag_duration_bars_min=1, flag_duration_bars_max=4)])

    forming_with_history = engine_with_history.evaluate(_snapshot(flag[-1].end, flag[-1].close), [*prepended, *flag])[0]
    flag_forming = next(v for v in forming_with_history if v.strategy == "BULL_FLAG")
    assert flag_forming.state == "FORMING"

    ready_with_history = engine_with_history.evaluate(_snapshot(breakout.end, breakout.close), [*prepended, *flag, breakout])[0]
    flag_ready = next(v for v in ready_with_history if v.strategy == "BULL_FLAG")
    assert flag_ready.state == "READY"


def test_wick_heavy_range_expansion_rejected_as_impulse() -> None:
    # 3 bars with giant wicks (high 105, low 95) but open=100.0, close=100.05 (net advance only 0.05, pole=10.0)
    wick_bars = [
        bar(0, 100.0, 105.0, 95.0, 100.02, 1_000),
        bar(1, 100.02, 105.0, 95.0, 100.03, 1_000),
        bar(2, 100.03, 105.0, 95.0, 100.05, 1_000),
        bar(3, 100.05, 100.2, 99.9, 100.1, 300),
        bar(4, 100.1, 100.25, 99.95, 100.15, 250),
    ]
    engine = StrategyEngine()
    engine.configure_profiles([_profile(flagpole_min_atr=0.5, flagpole_min_slope_atr_per_bar=0.1)])
    evaluations = engine.evaluate(_snapshot(wick_bars[-1].end, wick_bars[-1].close), wick_bars)[0]
    flag_res = next(v for v in evaluations if v.strategy == "BULL_FLAG")
    # Must reject the wick-dominated churn
    assert flag_res.state == "WATCH"
