from datetime import timedelta
from uuid import UUID

from app.models import CandleRecord, EntryWindow, ScannerProfileConfig, StrategyParameters
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, session, warmed_engine
from test_strategy_engine import bar


def _orb_bars(orh: float) -> tuple[list[CandleRecord], CandleRecord, CandleRecord]:
    base = [bar(3, orh - .1, orh, orh - .2, orh - .05, 100), bar(4, orh - .05, orh, orh - .1, orh, 100), bar(5, orh, orh + .02, orh - .05, orh, 100)]
    breakout = bar(6, orh, orh + .3, orh, orh + .2, 200)
    retest = bar(7, orh + .2, orh + .25, orh - .05, orh + .05, 120)
    return base, breakout, retest


def _run_to_ready(engine: StrategyEngine, snapshot, bars_so_far: list[CandleRecord], breakout: CandleRecord, retest: CandleRecord):
    engine.evaluate(snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}), [*bars_so_far, breakout])
    evaluations = engine.evaluate(snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}), [*bars_so_far, breakout, retest])[0]
    return next(value for value in evaluations if value.strategy == "ORB_RETEST")


def test_setup_instance_id_is_assigned_at_breakout_and_stable_through_ready() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, retest = _orb_bars(orh)
    engine = StrategyEngine()

    forming = engine.evaluate(snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}), [*base, breakout])[0]
    orb_forming = next(value for value in forming if value.strategy == "ORB_RETEST")
    assert orb_forming.state == "FORMING"
    assert orb_forming.setup_instance_id is not None

    ready = engine.evaluate(snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}), [*base, breakout, retest])[0]
    orb_ready = next(value for value in ready if value.strategy == "ORB_RETEST")
    assert orb_ready.state == "READY"
    assert orb_ready.setup_instance_id == orb_forming.setup_instance_id


def test_invalidated_setup_rearms_with_a_new_setup_instance_id() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, retest = _orb_bars(orh)
    engine = StrategyEngine()

    ready = _run_to_ready(engine, snapshot, base, breakout, retest)
    first_instance = ready.setup_instance_id
    assert ready.state == "READY" and first_instance is not None

    failure = bar(8, orh + .05, orh + .1, orh - 1.05, orh - 1, 100)
    history = [*base, breakout, retest, failure]
    invalidated = engine.evaluate(snapshot.model_copy(update={"timestamp": failure.end, "price": failure.close}), history)[0]
    orb_invalidated = next(value for value in invalidated if value.strategy == "ORB_RETEST")
    assert orb_invalidated.state == "INVALIDATED"
    assert orb_invalidated.setup_instance_id == first_instance

    new_breakout = bar(9, orh - 1, orh + .5, orh - 1.05, orh + .35, 250)
    new_retest = bar(10, orh + .35, orh + .4, orh - .05, orh + .05, 120)
    forming_again = engine.evaluate(snapshot.model_copy(update={"timestamp": new_breakout.end, "price": new_breakout.close}), [*history, new_breakout])[0]
    orb_forming_again = next(value for value in forming_again if value.strategy == "ORB_RETEST")
    assert orb_forming_again.state == "FORMING"
    assert orb_forming_again.setup_instance_id is not None
    assert orb_forming_again.setup_instance_id != first_instance

    ready_again = engine.evaluate(snapshot.model_copy(update={"timestamp": new_retest.end, "price": new_retest.close}), [*history, new_breakout, new_retest])[0]
    orb_ready_again = next(value for value in ready_again if value.strategy == "ORB_RETEST")
    assert orb_ready_again.state == "READY"
    assert orb_ready_again.setup_instance_id == orb_forming_again.setup_instance_id


def test_timeout_expires_and_rearms_for_a_later_breakout() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, _retest = _orb_bars(orh)
    profile = ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-000000000091"), profile_name="ORB Fast Timeout",
        strategy="ORB_RETEST", config_version="fast-timeout-v1",
        parameters=StrategyParameters(setup_timeout_minutes=5),
    )
    engine = StrategyEngine()
    engine.configure_profiles([profile])

    engine.evaluate(snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}), [*base, breakout])
    late = snapshot.model_copy(update={"timestamp": breakout.end + timedelta(minutes=6), "price": breakout.close})
    expired = engine.evaluate(late, [*base, breakout])[0]
    orb_expired = next(value for value in expired if value.strategy == "ORB_RETEST")
    assert orb_expired.state == "EXPIRED"
    assert "ORB_RETEST_TIMEOUT" in orb_expired.reason_codes
    assert orb_expired.setup_instance_id is not None

    new_breakout = bar(9, orh, orh + .5, orh, orh + .35, 250)
    new_retest = bar(10, orh + .35, orh + .4, orh - .05, orh + .05, 120)
    history = [*base, breakout, new_breakout]
    forming_again = engine.evaluate(snapshot.model_copy(update={"timestamp": new_breakout.end, "price": new_breakout.close}), history)[0]
    orb_forming_again = next(value for value in forming_again if value.strategy == "ORB_RETEST")
    assert orb_forming_again.state == "FORMING"
    assert orb_forming_again.setup_instance_id != orb_expired.setup_instance_id

    ready_again = engine.evaluate(snapshot.model_copy(update={"timestamp": new_retest.end, "price": new_retest.close}), [*history, new_retest])[0]
    orb_ready_again = next(value for value in ready_again if value.strategy == "ORB_RETEST")
    assert orb_ready_again.state == "READY"


def test_daily_reset_clears_memory_and_setup_instance_identity() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, retest = _orb_bars(orh)
    engine = StrategyEngine()

    ready = _run_to_ready(engine, snapshot, base, breakout, retest)
    assert ready.state == "READY" and ready.setup_instance_id is not None

    engine.reset()
    fresh = engine.evaluate(snapshot.model_copy(update={"timestamp": base[0].end, "price": base[0].close}), base)[0]
    orb_fresh = next(value for value in fresh if value.strategy == "ORB_RETEST")
    assert orb_fresh.state in ("WATCH", "FORMING")
    assert orb_fresh.setup_instance_id is None


def test_stale_data_freezes_the_formation_instead_of_discarding_it() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, _retest = _orb_bars(orh)
    engine = StrategyEngine()

    forming = engine.evaluate(snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}), [*base, breakout])[0]
    orb_forming = next(value for value in forming if value.strategy == "ORB_RETEST")
    assert orb_forming.setup_instance_id is not None

    stale = snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close, "actionable": False, "data_status": "DELAYED"})
    stalled = engine.evaluate(stale, [*base, breakout])[0]
    orb_stalled = next(value for value in stalled if value.strategy == "ORB_RETEST")
    assert orb_stalled.state == "DATA_STALE"
    assert orb_stalled.setup_instance_id == orb_forming.setup_instance_id


def test_wide_spread_invalidates_and_rearms_once_spread_recovers() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, retest = _orb_bars(orh)
    engine = StrategyEngine()

    ready = _run_to_ready(engine, snapshot, base, breakout, retest)
    assert ready.state == "READY"

    wide = snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close, "spread_pct": 1.0})
    invalidated = engine.evaluate(wide, [*base, breakout, retest])[0]
    orb_invalidated = next(value for value in invalidated if value.strategy == "ORB_RETEST")
    assert orb_invalidated.state == "INVALIDATED"
    assert "SPREAD_TOO_WIDE" in orb_invalidated.reason_codes

    # Re-arming re-detects the same breakout bar, so it reproduces the same deterministic
    # instance id (a transient spread blip on one formation, not a genuinely new one). It
    # takes one more tick to reconfirm the retest, same as the very first pass did.
    recovered = snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close})
    recovered_eval = engine.evaluate(recovered, [*base, breakout, retest])[0]
    orb_recovered = next(value for value in recovered_eval if value.strategy == "ORB_RETEST")
    assert orb_recovered.state == "FORMING"
    assert orb_recovered.setup_instance_id == orb_invalidated.setup_instance_id

    reconfirmed = engine.evaluate(recovered, [*base, breakout, retest])[0]
    orb_reconfirmed = next(value for value in reconfirmed if value.strategy == "ORB_RETEST")
    assert orb_reconfirmed.state == "READY"
    assert orb_reconfirmed.setup_instance_id == orb_invalidated.setup_instance_id


def test_no_signal_session_never_assigns_a_setup_instance() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    quiet = [bar(3, orh - .5, orh - .3, orh - .6, orh - .4, 100), bar(4, orh - .4, orh - .2, orh - .5, orh - .3, 100)]
    engine = StrategyEngine()

    evaluations = engine.evaluate(snapshot.model_copy(update={"timestamp": quiet[-1].end, "price": quiet[-1].close}), quiet)[0]
    orb = next(value for value in evaluations if value.strategy == "ORB_RETEST")
    assert orb.state == "WATCH"
    assert orb.setup_instance_id is None


def test_profile_entry_window_overrides_the_session_wide_entry_window() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, retest = _orb_bars(orh)

    default_engine = StrategyEngine()
    default_engine.start_session(session())
    default_ready = _run_to_ready(default_engine, snapshot, base, breakout, retest)
    assert default_ready.state == "READY"

    late_window = EntryWindow(preferred_start="11:00", preferred_end="11:30", hard_end="12:00")
    profile = ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-000000000092"), profile_name="ORB Late Window",
        strategy="ORB_RETEST", config_version="late-window-v1", entry_window=late_window,
    )
    narrow_engine = StrategyEngine()
    narrow_engine.start_session(session())
    narrow_engine.configure_profiles([profile])
    narrow_result = _run_to_ready(narrow_engine, snapshot, base, breakout, retest)
    assert narrow_result.state == "FORMING"
    assert "WAITING_FOR_PREFERRED_ENTRY_WINDOW" in narrow_result.reason_codes
