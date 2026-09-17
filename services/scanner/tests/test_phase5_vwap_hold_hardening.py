from datetime import timedelta
from uuid import UUID

from app.models import CandleRecord, EntryWindow, ScannerProfileConfig, StrategyParameters
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, session, warmed_engine
from test_strategy_engine import bar

VWAP = 100.0


def _vwap_snapshot(engine: StrategyEngine, timestamp, price: float, **updates):
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    base = {"timestamp": timestamp, "price": price, "vwap": VWAP, "completed_bar_vwap": VWAP, "close_above_vwap": True, "last_3_closes_above_vwap": 3}
    return snapshot.model_copy(update={**base, **updates})


def _vwap_bars() -> tuple[list[CandleRecord], CandleRecord, CandleRecord]:
    base = [bar(3, 101, 101.5, 100.8, 101.2, 100), bar(4, 101.2, 101.6, 101, 101.4, 100)]
    pullback = bar(5, 101.4, 101.5, 99.9, 100.1, 100)
    hold = bar(6, 100.1, 101.8, 100.05, 101.6, 150)
    return base, pullback, hold


def _run_to_ready(engine: StrategyEngine, base: list[CandleRecord], pullback: CandleRecord, hold: CandleRecord):
    engine.evaluate(_vwap_snapshot(engine, pullback.end, pullback.close), [*base, pullback])
    evaluations = engine.evaluate(_vwap_snapshot(engine, hold.end, hold.close), [*base, pullback, hold])[0]
    return next(value for value in evaluations if value.strategy == "VWAP_HOLD")


def _profile(**parameters) -> ScannerProfileConfig:
    return ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000a1"), profile_name="VWAP Hold Test",
        strategy="VWAP_HOLD", config_version="phase5-vwap-test", parameters=StrategyParameters(**parameters),
    )


def test_setup_instance_id_is_assigned_at_pullback_and_stable_through_ready() -> None:
    base, pullback, hold = _vwap_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    forming = engine.evaluate(_vwap_snapshot(engine, pullback.end, pullback.close), [*base, pullback])[0]
    vwap_forming = next(value for value in forming if value.strategy == "VWAP_HOLD")
    assert vwap_forming.state == "FORMING"
    assert vwap_forming.setup_instance_id is not None

    ready = engine.evaluate(_vwap_snapshot(engine, hold.end, hold.close), [*base, pullback, hold])[0]
    vwap_ready = next(value for value in ready if value.strategy == "VWAP_HOLD")
    assert vwap_ready.state == "READY"
    assert vwap_ready.setup_instance_id == vwap_forming.setup_instance_id


def test_invalidated_setup_rearms_with_a_new_setup_instance_id() -> None:
    base, pullback, hold = _vwap_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, base, pullback, hold)
    first_instance = ready.setup_instance_id
    assert ready.state == "READY" and first_instance is not None

    failure = bar(7, 101.6, 101.7, 98, 98.2, 100)
    history = [*base, pullback, hold, failure]
    invalidated = engine.evaluate(_vwap_snapshot(engine, failure.end, failure.close), history)[0]
    vwap_invalidated = next(value for value in invalidated if value.strategy == "VWAP_HOLD")
    assert vwap_invalidated.state == "INVALIDATED"
    assert vwap_invalidated.setup_instance_id == first_instance

    new_pullback = bar(8, 98.2, 100.2, 99.9, 100.1, 100)
    new_hold = bar(9, 100.1, 101.9, 100.05, 101.7, 150)
    forming_again = engine.evaluate(_vwap_snapshot(engine, new_pullback.end, new_pullback.close), [*history, new_pullback])[0]
    vwap_forming_again = next(value for value in forming_again if value.strategy == "VWAP_HOLD")
    assert vwap_forming_again.state == "FORMING"
    assert vwap_forming_again.setup_instance_id is not None
    assert vwap_forming_again.setup_instance_id != first_instance

    ready_again = engine.evaluate(_vwap_snapshot(engine, new_hold.end, new_hold.close), [*history, new_pullback, new_hold])[0]
    vwap_ready_again = next(value for value in ready_again if value.strategy == "VWAP_HOLD")
    assert vwap_ready_again.state == "READY"
    assert vwap_ready_again.setup_instance_id == vwap_forming_again.setup_instance_id


def test_timeout_expires_and_rearms_for_a_later_pullback() -> None:
    base, pullback, _hold = _vwap_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile(setup_timeout_minutes=5)])

    engine.evaluate(_vwap_snapshot(engine, pullback.end, pullback.close), [*base, pullback])
    late = _vwap_snapshot(engine, pullback.end + timedelta(minutes=6), pullback.close)
    expired = engine.evaluate(late, [*base, pullback])[0]
    vwap_expired = next(value for value in expired if value.strategy == "VWAP_HOLD")
    assert vwap_expired.state == "EXPIRED"
    assert "VWAP_HOLD_TIMEOUT" in vwap_expired.reason_codes
    assert vwap_expired.setup_instance_id is not None

    new_pullback = bar(9, 101.4, 101.5, 99.9, 100.1, 100)
    new_hold = bar(10, 100.1, 101.8, 100.05, 101.6, 150)
    history = [*base, pullback, new_pullback]
    forming_again = engine.evaluate(_vwap_snapshot(engine, new_pullback.end, new_pullback.close), history)[0]
    vwap_forming_again = next(value for value in forming_again if value.strategy == "VWAP_HOLD")
    assert vwap_forming_again.state == "FORMING"
    assert vwap_forming_again.setup_instance_id != vwap_expired.setup_instance_id

    ready_again = engine.evaluate(_vwap_snapshot(engine, new_hold.end, new_hold.close), [*history, new_hold])[0]
    vwap_ready_again = next(value for value in ready_again if value.strategy == "VWAP_HOLD")
    assert vwap_ready_again.state == "READY"


def test_daily_reset_clears_memory_and_setup_instance_identity() -> None:
    base, pullback, hold = _vwap_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, base, pullback, hold)
    assert ready.state == "READY" and ready.setup_instance_id is not None

    engine.reset()
    fresh = engine.evaluate(_vwap_snapshot(engine, base[0].end, base[0].close), base)[0]
    vwap_fresh = next(value for value in fresh if value.strategy == "VWAP_HOLD")
    assert vwap_fresh.state in ("WATCH", "FORMING")
    assert vwap_fresh.setup_instance_id is None


def test_stale_data_freezes_the_formation_instead_of_discarding_it() -> None:
    base, pullback, _hold = _vwap_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    forming = engine.evaluate(_vwap_snapshot(engine, pullback.end, pullback.close), [*base, pullback])[0]
    vwap_forming = next(value for value in forming if value.strategy == "VWAP_HOLD")
    assert vwap_forming.setup_instance_id is not None

    stale = _vwap_snapshot(engine, pullback.end, pullback.close, actionable=False, data_status="DELAYED")
    stalled = engine.evaluate(stale, [*base, pullback])[0]
    vwap_stalled = next(value for value in stalled if value.strategy == "VWAP_HOLD")
    assert vwap_stalled.state == "DATA_STALE"
    assert vwap_stalled.setup_instance_id == vwap_forming.setup_instance_id


def test_wide_spread_invalidates_the_formation() -> None:
    base, pullback, hold = _vwap_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, base, pullback, hold)
    assert ready.state == "READY"

    wide = _vwap_snapshot(engine, hold.end, hold.close, spread_pct=1.0)
    invalidated = engine.evaluate(wide, [*base, pullback, hold])[0]
    vwap_invalidated = next(value for value in invalidated if value.strategy == "VWAP_HOLD")
    assert vwap_invalidated.state == "INVALIDATED"
    assert "SPREAD_TOO_WIDE" in vwap_invalidated.reason_codes


def test_no_signal_session_never_assigns_a_setup_instance() -> None:
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])
    quiet = [bar(3, 99, 99.5, 98.8, 99.2, 100), bar(4, 99.2, 99.6, 99, 99.4, 100)]

    evaluations = engine.evaluate(_vwap_snapshot(engine, quiet[-1].end, quiet[-1].close, close_above_vwap=False, last_3_closes_above_vwap=0), quiet)[0]
    vwap = next(value for value in evaluations if value.strategy == "VWAP_HOLD")
    assert vwap.state == "WATCH"
    assert vwap.setup_instance_id is None


def test_profile_entry_window_overrides_the_session_wide_entry_window() -> None:
    base, pullback, hold = _vwap_bars()

    default_engine = StrategyEngine()
    default_engine.start_session(session())
    default_engine.configure_profiles([_profile()])
    default_ready = _run_to_ready(default_engine, base, pullback, hold)
    assert default_ready.state == "READY"

    late_window = EntryWindow(preferred_start="11:00", preferred_end="11:30", hard_end="12:00")
    profile = ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000a2"), profile_name="VWAP Hold Late Window",
        strategy="VWAP_HOLD", config_version="late-window-v1", entry_window=late_window,
    )
    narrow_engine = StrategyEngine()
    narrow_engine.start_session(session())
    narrow_engine.configure_profiles([profile])
    narrow_result = _run_to_ready(narrow_engine, base, pullback, hold)
    assert narrow_result.state == "FORMING"
    assert "WAITING_FOR_PREFERRED_ENTRY_WINDOW" in narrow_result.reason_codes
