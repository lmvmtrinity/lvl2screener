from datetime import timedelta
from uuid import UUID

from app.models import CandleRecord, EntryWindow, ScannerProfileConfig, StrategyParameters
from app.strategies.base import StrategyContext
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, session, warmed_engine
from test_strategy_engine import bar

PDH = 100.0


def _snapshot(timestamp, price: float, **updates):
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    base = {"timestamp": timestamp, "price": price}
    return snapshot.model_copy(update={**base, **updates})


def _pdh_bars() -> tuple[CandleRecord, CandleRecord]:
    baseline = bar(3, 99, 99.8, 98.8, 99.5, 100)
    breakout = bar(4, 99.5, 101.2, 99.4, 101, 250)
    return baseline, breakout


def _profile(**parameters) -> ScannerProfileConfig:
    return ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000d1"), profile_name="PDH Breakout Test",
        strategy="PRIOR_DAY_HIGH_BREAKOUT", config_version="phase5-pdh-test", parameters=StrategyParameters(**parameters),
    )


def _run_to_ready(engine: StrategyEngine, baseline: CandleRecord, breakout: CandleRecord):
    evaluations = engine.evaluate(_snapshot(breakout.end, breakout.close), StrategyContext(bars=[baseline, breakout], prior_day_high=PDH))[0]
    return next(value for value in evaluations if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")


def test_setup_instance_id_is_assigned_at_confirmed_breakout() -> None:
    baseline, breakout = _pdh_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, baseline, breakout)
    assert ready.state == "READY"
    assert ready.setup_instance_id is not None


def test_invalidated_setup_rearms_with_a_new_setup_instance_id() -> None:
    baseline, breakout = _pdh_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, baseline, breakout)
    first_instance = ready.setup_instance_id
    assert ready.state == "READY" and first_instance is not None

    failure = bar(5, 101, 101.1, 98, 98.2, 100)
    history = [baseline, breakout, failure]
    invalidated = engine.evaluate(_snapshot(failure.end, failure.close), StrategyContext(bars=history, prior_day_high=PDH))[0]
    pdh_invalidated = next(value for value in invalidated if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert pdh_invalidated.state == "INVALIDATED"
    assert pdh_invalidated.setup_instance_id == first_instance

    new_breakout = bar(6, 98.2, 101.5, 98.1, 101.3, 250)
    ready_again_eval = engine.evaluate(_snapshot(new_breakout.end, new_breakout.close), StrategyContext(bars=[*history, new_breakout], prior_day_high=PDH))[0]
    pdh_ready_again = next(value for value in ready_again_eval if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert pdh_ready_again.state == "READY"
    assert pdh_ready_again.setup_instance_id is not None
    assert pdh_ready_again.setup_instance_id != first_instance


def test_timeout_expires_a_stalled_near_high_pending_state() -> None:
    baseline = bar(3, 99, 99.8, 98.8, 99.5, 100)
    near = bar(4, 99.5, 99.9, 99.4, 99.75, 100)
    engine = StrategyEngine()
    engine.configure_profiles([_profile(setup_timeout_minutes=5)])

    forming = engine.evaluate(_snapshot(near.end, near.close), StrategyContext(bars=[baseline, near], prior_day_high=PDH))[0]
    pdh_forming = next(value for value in forming if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert pdh_forming.state == "FORMING"

    late = _snapshot(near.end + timedelta(minutes=6), near.close)
    expired = engine.evaluate(late, StrategyContext(bars=[baseline, near], prior_day_high=PDH))[0]
    pdh_expired = next(value for value in expired if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert pdh_expired.state == "EXPIRED"
    assert "PRIOR_DAY_HIGH_BREAKOUT_TIMEOUT" in pdh_expired.reason_codes


def test_daily_reset_clears_memory_and_setup_instance_identity() -> None:
    baseline, breakout = _pdh_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, baseline, breakout)
    assert ready.state == "READY" and ready.setup_instance_id is not None

    engine.reset()
    fresh = engine.evaluate(_snapshot(baseline.end, baseline.close), StrategyContext(bars=[baseline], prior_day_high=PDH))[0]
    pdh_fresh = next(value for value in fresh if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert pdh_fresh.state in ("WATCH", "FORMING")
    assert pdh_fresh.setup_instance_id is None


def test_stale_data_freezes_the_formation_instead_of_discarding_it() -> None:
    baseline, breakout = _pdh_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, baseline, breakout)
    assert ready.setup_instance_id is not None

    stale = _snapshot(breakout.end, breakout.close, actionable=False, data_status="DELAYED")
    stalled = engine.evaluate(stale, StrategyContext(bars=[baseline, breakout], prior_day_high=PDH))[0]
    pdh_stalled = next(value for value in stalled if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert pdh_stalled.state == "DATA_STALE"
    assert pdh_stalled.setup_instance_id == ready.setup_instance_id


def test_wide_spread_invalidates_the_formation() -> None:
    baseline, breakout = _pdh_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, baseline, breakout)
    assert ready.state == "READY"

    wide = _snapshot(breakout.end, breakout.close, spread_pct=1.0)
    invalidated = engine.evaluate(wide, StrategyContext(bars=[baseline, breakout], prior_day_high=PDH))[0]
    pdh_invalidated = next(value for value in invalidated if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert pdh_invalidated.state == "INVALIDATED"
    assert "SPREAD_TOO_WIDE" in pdh_invalidated.reason_codes


def test_no_signal_session_never_assigns_a_setup_instance() -> None:
    quiet = bar(3, 90, 91, 89.8, 90.5, 100)
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    evaluations = engine.evaluate(_snapshot(quiet.end, quiet.close), StrategyContext(bars=[quiet], prior_day_high=PDH))[0]
    pdh = next(value for value in evaluations if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert pdh.state == "WATCH"
    assert pdh.setup_instance_id is None


def test_profile_entry_window_overrides_the_session_wide_entry_window() -> None:
    baseline = bar(6, 99, 99.8, 98.8, 99.5, 100)
    breakout = bar(7, 99.5, 101.2, 99.4, 101, 250)

    default_engine = StrategyEngine()
    default_engine.start_session(session())
    default_engine.configure_profiles([_profile()])
    default_result = next(value for value in default_engine.evaluate(_snapshot(breakout.end, breakout.close), StrategyContext(bars=[baseline, breakout], prior_day_high=PDH))[0] if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert default_result.state == "READY"

    late_window = EntryWindow(preferred_start="11:00", preferred_end="11:30", hard_end="12:00")
    profile = ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000d2"), profile_name="PDH Late Window",
        strategy="PRIOR_DAY_HIGH_BREAKOUT", config_version="late-window-v1", entry_window=late_window,
    )
    narrow_engine = StrategyEngine()
    narrow_engine.start_session(session())
    narrow_engine.configure_profiles([profile])
    narrow_result = next(value for value in narrow_engine.evaluate(_snapshot(breakout.end, breakout.close), StrategyContext(bars=[baseline, breakout], prior_day_high=PDH))[0] if value.strategy == "PRIOR_DAY_HIGH_BREAKOUT")
    assert narrow_result.state == "FORMING"
    assert "WAITING_FOR_PREFERRED_ENTRY_WINDOW" in narrow_result.reason_codes
