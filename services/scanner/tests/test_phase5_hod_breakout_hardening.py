from datetime import timedelta
from uuid import UUID

from app.models import CandleRecord, EntryWindow, ScannerProfileConfig, StrategyParameters
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, session, warmed_engine
from test_strategy_engine import bar


def _base_bars() -> list[CandleRecord]:
    return [bar(0, 99.5, 99.9, 99.4, 99.8, 100), bar(1, 99.7, 99.95, 99.6, 99.85, 100), bar(2, 99.8, 100, 99.7, 99.9, 100)]


def _breakout_bar() -> CandleRecord:
    return bar(3, 99.9, 101.2, 99.8, 101, 250)


def _snapshot(timestamp, price: float, **updates):
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    return snapshot.model_copy(update={"timestamp": timestamp, "price": price, **updates})


def _profile(**parameters) -> ScannerProfileConfig:
    return ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000c1"), profile_name="HOD Breakout Test",
        strategy="HIGH_OF_DAY_BREAKOUT", config_version="phase5-hod-test", parameters=StrategyParameters(**parameters),
    )


def test_setup_instance_id_is_assigned_at_confirmed_breakout() -> None:
    base = _base_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = engine.evaluate(_snapshot(breakout.end, breakout.close), [*base, breakout])[0]
    hod_ready = next(value for value in ready if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_ready.state == "READY"
    assert hod_ready.setup_instance_id is not None


def test_vertical_spike_without_consolidated_base_does_not_confirm() -> None:
    spiky = [bar(0, 95, 96, 94.8, 95.9, 100), bar(1, 95.9, 98, 95.8, 97.8, 100), bar(2, 97.8, 100, 97.7, 99.9, 100)]
    breakout = bar(3, 99.9, 101.2, 99.8, 101, 250)
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    result = engine.evaluate(_snapshot(breakout.end, breakout.close), [*spiky, breakout])[0]
    hod = next(value for value in result if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod.state == "WATCH"
    assert "HIGH_OF_DAY_CONSOLIDATION_INSUFFICIENT" in hod.reason_codes
    assert hod.setup_instance_id is None


def test_invalidated_setup_rearms_with_a_new_setup_instance_id() -> None:
    base = _base_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = engine.evaluate(_snapshot(breakout.end, breakout.close), [*base, breakout])[0]
    hod_ready = next(value for value in ready if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    first_instance = hod_ready.setup_instance_id
    assert hod_ready.state == "READY" and first_instance is not None

    failure = bar(4, 101, 101.1, 98, 98.2, 100)
    history = [*base, breakout, failure]
    invalidated = engine.evaluate(_snapshot(failure.end, failure.close), history)[0]
    hod_invalidated = next(value for value in invalidated if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_invalidated.state == "INVALIDATED"
    assert hod_invalidated.setup_instance_id == first_instance

    new_base = [bar(5, 98.2, 98.6, 98.1, 98.5, 100), bar(6, 98.4, 98.7, 98.3, 98.6, 100), bar(7, 98.5, 98.8, 98.4, 98.7, 100)]
    new_breakout = bar(8, 98.7, 102, 98.6, 101.5, 250)
    forming_again = engine.evaluate(_snapshot(new_breakout.end, new_breakout.close), [*history, *new_base, new_breakout])[0]
    hod_forming_again = next(value for value in forming_again if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_forming_again.state == "READY"
    assert hod_forming_again.setup_instance_id is not None
    assert hod_forming_again.setup_instance_id != first_instance


def test_timeout_expires_a_stalled_near_high_pending_state() -> None:
    base = _base_bars()
    near = bar(3, 99.9, 100, 99.85, 99.95, 100)
    engine = StrategyEngine()
    engine.configure_profiles([_profile(setup_timeout_minutes=5)])

    forming = engine.evaluate(_snapshot(near.end, near.close), [*base, near])[0]
    hod_forming = next(value for value in forming if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_forming.state == "FORMING"

    late = _snapshot(near.end + timedelta(minutes=6), near.close)
    expired = engine.evaluate(late, [*base, near])[0]
    hod_expired = next(value for value in expired if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_expired.state == "EXPIRED"
    assert "HIGH_OF_DAY_BREAKOUT_TIMEOUT" in hod_expired.reason_codes


def test_daily_reset_clears_memory_and_setup_instance_identity() -> None:
    base = _base_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = engine.evaluate(_snapshot(breakout.end, breakout.close), [*base, breakout])[0]
    hod_ready = next(value for value in ready if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_ready.state == "READY" and hod_ready.setup_instance_id is not None

    engine.reset()
    fresh = engine.evaluate(_snapshot(base[-1].end, base[-1].close), base)[0]
    hod_fresh = next(value for value in fresh if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_fresh.state in ("WATCH", "FORMING")
    assert hod_fresh.setup_instance_id is None


def test_stale_data_freezes_the_formation_instead_of_discarding_it() -> None:
    base = _base_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = engine.evaluate(_snapshot(breakout.end, breakout.close), [*base, breakout])[0]
    hod_ready = next(value for value in ready if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_ready.setup_instance_id is not None

    stale = _snapshot(breakout.end, breakout.close, actionable=False, data_status="DELAYED")
    stalled = engine.evaluate(stale, [*base, breakout])[0]
    hod_stalled = next(value for value in stalled if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_stalled.state == "DATA_STALE"
    assert hod_stalled.setup_instance_id == hod_ready.setup_instance_id


def test_wide_spread_invalidates_the_formation() -> None:
    base = _base_bars()
    breakout = _breakout_bar()
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    ready = engine.evaluate(_snapshot(breakout.end, breakout.close), [*base, breakout])[0]
    hod_ready = next(value for value in ready if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_ready.state == "READY"

    wide = _snapshot(breakout.end, breakout.close, spread_pct=1.0)
    invalidated = engine.evaluate(wide, [*base, breakout])[0]
    hod_invalidated = next(value for value in invalidated if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod_invalidated.state == "INVALIDATED"
    assert "SPREAD_TOO_WIDE" in hod_invalidated.reason_codes


def test_no_signal_session_never_assigns_a_setup_instance() -> None:
    quiet = [bar(0, 99, 99.3, 98.8, 99, 100), bar(1, 98.5, 98.8, 98.3, 98.5, 100)]
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    evaluations = engine.evaluate(_snapshot(quiet[-1].end, quiet[-1].close), quiet)[0]
    hod = next(value for value in evaluations if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert hod.state == "WATCH"
    assert hod.setup_instance_id is None


def test_profile_entry_window_overrides_the_session_wide_entry_window() -> None:
    base = [bar(3, 99.5, 99.9, 99.4, 99.8, 100), bar(4, 99.7, 99.95, 99.6, 99.85, 100), bar(5, 99.8, 100, 99.7, 99.9, 100)]
    breakout = bar(6, 99.9, 101.2, 99.8, 101, 250)

    default_engine = StrategyEngine()
    default_engine.start_session(session())
    default_engine.configure_profiles([_profile()])
    default_ready = default_engine.evaluate(_snapshot(breakout.end, breakout.close), [*base, breakout])[0]
    default_result = next(value for value in default_ready if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert default_result.state == "READY"

    late_window = EntryWindow(preferred_start="11:00", preferred_end="11:30", hard_end="12:00")
    profile = ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000c2"), profile_name="HOD Late Window",
        strategy="HIGH_OF_DAY_BREAKOUT", config_version="late-window-v1", entry_window=late_window,
    )
    narrow_engine = StrategyEngine()
    narrow_engine.start_session(session())
    narrow_engine.configure_profiles([profile])
    narrow_ready = narrow_engine.evaluate(_snapshot(breakout.end, breakout.close), [*base, breakout])[0]
    narrow_result = next(value for value in narrow_ready if value.strategy == "HIGH_OF_DAY_BREAKOUT")
    assert narrow_result.state == "FORMING"
    assert "WAITING_FOR_PREFERRED_ENTRY_WINDOW" in narrow_result.reason_codes
    assert narrow_result.entry_window == late_window
    assert narrow_result.model_dump(by_alias=True)["entryWindow"]["hardEnd"] == "12:00"
