from datetime import timedelta
from uuid import UUID

from app.models import CandleRecord, EntryWindow, ScannerProfileConfig, StrategyParameters
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, session, warmed_engine
from test_strategy_engine import bar

VWAP = 100.0


def _reclaim_snapshot(timestamp, price: float, **updates):
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    base = {"timestamp": timestamp, "price": price, "vwap": VWAP, "completed_bar_vwap": VWAP, "vwap_reclaim": False}
    return snapshot.model_copy(update={**base, **updates})


def _reclaim_bars() -> tuple[CandleRecord, CandleRecord]:
    first = bar(5, 99.8, 100.5, 99.7, 100.3, 500)
    hold = bar(6, 100.3, 101, 100.1, 100.8, 600)
    return first, hold


def _profile(**parameters) -> ScannerProfileConfig:
    return ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000b1"), profile_name="VWAP Reclaim Test",
        strategy="VWAP_RECLAIM", config_version="phase5-vwap-reclaim-test", parameters=StrategyParameters(**parameters),
    )


def _run_to_ready(engine: StrategyEngine, first: CandleRecord, hold: CandleRecord):
    engine.evaluate(_reclaim_snapshot(first.end, first.close, vwap_reclaim=True), [first])
    evaluations = engine.evaluate(_reclaim_snapshot(hold.end, hold.close), [first, hold])[0]
    return next(value for value in evaluations if value.strategy == "VWAP_RECLAIM")


def test_setup_instance_id_is_assigned_at_reclaim_and_stable_through_ready() -> None:
    first, hold = _reclaim_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    forming = engine.evaluate(_reclaim_snapshot(first.end, first.close, vwap_reclaim=True), [first])[0]
    reclaim_forming = next(value for value in forming if value.strategy == "VWAP_RECLAIM")
    assert reclaim_forming.state == "FORMING"
    assert reclaim_forming.setup_instance_id is not None

    ready = engine.evaluate(_reclaim_snapshot(hold.end, hold.close), [first, hold])[0]
    reclaim_ready = next(value for value in ready if value.strategy == "VWAP_RECLAIM")
    assert reclaim_ready.state == "READY"
    assert reclaim_ready.setup_instance_id == reclaim_forming.setup_instance_id


def test_invalidated_setup_rearms_with_a_new_setup_instance_id() -> None:
    first, hold = _reclaim_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, first, hold)
    first_instance = ready.setup_instance_id
    assert ready.state == "READY" and first_instance is not None

    failure = bar(7, 100.8, 100.9, 96, 96.2, 100)
    history = [first, hold, failure]
    invalidated = engine.evaluate(_reclaim_snapshot(failure.end, failure.close), history)[0]
    reclaim_invalidated = next(value for value in invalidated if value.strategy == "VWAP_RECLAIM")
    assert reclaim_invalidated.state == "INVALIDATED"
    assert reclaim_invalidated.setup_instance_id == first_instance

    new_first = bar(8, 96.2, 100.5, 96, 100.3, 500)
    new_hold = bar(9, 100.3, 101, 100.1, 100.8, 600)
    forming_again = engine.evaluate(_reclaim_snapshot(new_first.end, new_first.close, vwap_reclaim=True), [*history, new_first])[0]
    reclaim_forming_again = next(value for value in forming_again if value.strategy == "VWAP_RECLAIM")
    assert reclaim_forming_again.state == "FORMING"
    assert reclaim_forming_again.setup_instance_id is not None
    assert reclaim_forming_again.setup_instance_id != first_instance

    ready_again = engine.evaluate(_reclaim_snapshot(new_hold.end, new_hold.close), [*history, new_first, new_hold])[0]
    reclaim_ready_again = next(value for value in ready_again if value.strategy == "VWAP_RECLAIM")
    assert reclaim_ready_again.state == "READY"
    assert reclaim_ready_again.setup_instance_id == reclaim_forming_again.setup_instance_id


def test_timeout_expires_and_rearms_for_a_later_reclaim() -> None:
    first, _hold = _reclaim_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile(setup_timeout_minutes=5)])

    engine.evaluate(_reclaim_snapshot(first.end, first.close, vwap_reclaim=True), [first])
    late = _reclaim_snapshot(first.end + timedelta(minutes=6), first.close)
    expired = engine.evaluate(late, [first])[0]
    reclaim_expired = next(value for value in expired if value.strategy == "VWAP_RECLAIM")
    assert reclaim_expired.state == "EXPIRED"
    assert "VWAP_RECLAIM_TIMEOUT" in reclaim_expired.reason_codes
    assert reclaim_expired.setup_instance_id is not None

    new_first = bar(9, 99.8, 100.5, 99.7, 100.3, 500)
    new_hold = bar(10, 100.3, 101, 100.1, 100.8, 600)
    history = [first, new_first]
    forming_again = engine.evaluate(_reclaim_snapshot(new_first.end, new_first.close, vwap_reclaim=True), history)[0]
    reclaim_forming_again = next(value for value in forming_again if value.strategy == "VWAP_RECLAIM")
    assert reclaim_forming_again.state == "FORMING"
    assert reclaim_forming_again.setup_instance_id != reclaim_expired.setup_instance_id

    ready_again = engine.evaluate(_reclaim_snapshot(new_hold.end, new_hold.close), [*history, new_hold])[0]
    reclaim_ready_again = next(value for value in ready_again if value.strategy == "VWAP_RECLAIM")
    assert reclaim_ready_again.state == "READY"


def test_daily_reset_clears_memory_and_setup_instance_identity() -> None:
    first, hold = _reclaim_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, first, hold)
    assert ready.state == "READY" and ready.setup_instance_id is not None

    engine.reset()
    fresh = engine.evaluate(_reclaim_snapshot(first.end, first.close), [first])[0]
    reclaim_fresh = next(value for value in fresh if value.strategy == "VWAP_RECLAIM")
    assert reclaim_fresh.state == "WATCH"
    assert reclaim_fresh.setup_instance_id is None


def test_stale_data_freezes_the_formation_instead_of_discarding_it() -> None:
    first, _hold = _reclaim_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    forming = engine.evaluate(_reclaim_snapshot(first.end, first.close, vwap_reclaim=True), [first])[0]
    reclaim_forming = next(value for value in forming if value.strategy == "VWAP_RECLAIM")
    assert reclaim_forming.setup_instance_id is not None

    stale = _reclaim_snapshot(first.end, first.close, actionable=False, data_status="DELAYED")
    stalled = engine.evaluate(stale, [first])[0]
    reclaim_stalled = next(value for value in stalled if value.strategy == "VWAP_RECLAIM")
    assert reclaim_stalled.state == "DATA_STALE"
    assert reclaim_stalled.setup_instance_id == reclaim_forming.setup_instance_id


def test_wide_spread_invalidates_the_formation() -> None:
    first, hold = _reclaim_bars()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = _run_to_ready(engine, first, hold)
    assert ready.state == "READY"

    wide = _reclaim_snapshot(hold.end, hold.close, spread_pct=1.0)
    invalidated = engine.evaluate(wide, [first, hold])[0]
    reclaim_invalidated = next(value for value in invalidated if value.strategy == "VWAP_RECLAIM")
    assert reclaim_invalidated.state == "INVALIDATED"
    assert "SPREAD_TOO_WIDE" in reclaim_invalidated.reason_codes


def test_no_signal_session_never_assigns_a_setup_instance() -> None:
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])
    quiet = [bar(3, 99, 99.3, 98.8, 99, 100)]

    evaluations = engine.evaluate(_reclaim_snapshot(quiet[-1].end, quiet[-1].close), quiet)[0]
    reclaim = next(value for value in evaluations if value.strategy == "VWAP_RECLAIM")
    assert reclaim.state == "WATCH"
    assert reclaim.setup_instance_id is None


def test_profile_entry_window_overrides_the_session_wide_entry_window() -> None:
    first, hold = _reclaim_bars()

    default_engine = StrategyEngine()
    default_engine.start_session(session())
    default_engine.configure_profiles([_profile()])
    default_ready = _run_to_ready(default_engine, first, hold)
    assert default_ready.state == "READY"

    late_window = EntryWindow(preferred_start="11:00", preferred_end="11:30", hard_end="12:00")
    profile = ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000b2"), profile_name="VWAP Reclaim Late Window",
        strategy="VWAP_RECLAIM", config_version="late-window-v1", entry_window=late_window,
    )
    narrow_engine = StrategyEngine()
    narrow_engine.start_session(session())
    narrow_engine.configure_profiles([profile])
    narrow_result = _run_to_ready(narrow_engine, first, hold)
    assert narrow_result.state == "FORMING"
    assert "WAITING_FOR_PREFERRED_ENTRY_WINDOW" in narrow_result.reason_codes
