from datetime import timedelta
from uuid import UUID

from app.models import ScannerProfileConfig, StrategyParameters
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, warmed_engine
from test_phase5_orb_hardening import _orb_bars

STABLE = {"spreadConfirmQuotes": 3, "spreadConfirmSeconds": 5, "spreadRecoveryPct": 80, "spreadMinTicks": 3}


def _engine(**parameters: float) -> StrategyEngine:
    engine = StrategyEngine()
    engine.configure_profiles([
        ScannerProfileConfig(
            profile_id=UUID("10000000-0000-4000-8000-0000000000e1"), profile_name="ORB spread gate",
            strategy="ORB_RETEST", config_version="spread-gate-test",
            parameters=StrategyParameters.model_validate(parameters),
        )
    ])
    return engine


def _orb(engine: StrategyEngine, snapshot, history, *, seconds: float = 0, **update):
    at = history[-1].end + timedelta(seconds=seconds)
    values = engine.evaluate(snapshot.model_copy(update={"timestamp": at, "price": history[-1].close, **update}), history)[0]
    return next(value for value in values if value.strategy == "ORB_RETEST")


def _ready(engine: StrategyEngine):
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    base, breakout, retest = _orb_bars(snapshot.opening_range.high)
    assert _orb(engine, snapshot, [*base, breakout]).state == "FORMING"
    history = [*base, breakout, retest]
    assert _orb(engine, snapshot, history).state == "READY"
    return snapshot, history


def test_default_parameters_keep_the_single_quote_gate() -> None:
    engine = _engine()
    snapshot, history = _ready(engine)
    assert _orb(engine, snapshot, history, seconds=2, spread_pct=1.0).state == "INVALIDATED"


def test_a_brief_spread_spike_keeps_the_setup_ready() -> None:
    engine = _engine(**STABLE)
    snapshot, history = _ready(engine)
    spike = _orb(engine, snapshot, history, seconds=2, spread_pct=1.0)
    assert spike.state == "READY"
    assert "SPREAD_WIDE_UNCONFIRMED" in spike.reason_codes
    assert _orb(engine, snapshot, history, seconds=4).state == "READY"


def test_a_sustained_wide_spread_invalidates_after_quotes_and_seconds() -> None:
    engine = _engine(**STABLE)
    snapshot, history = _ready(engine)
    assert _orb(engine, snapshot, history, seconds=2, spread_pct=1.0).state == "READY"
    assert _orb(engine, snapshot, history, seconds=4, spread_pct=1.0).state == "READY"
    # Three wide quotes, but only four seconds since the first one.
    assert _orb(engine, snapshot, history, seconds=6, spread_pct=1.0).state == "READY"
    blocked = _orb(engine, snapshot, history, seconds=8, spread_pct=1.0)
    assert blocked.state == "INVALIDATED"
    assert "SPREAD_TOO_WIDE" in blocked.reason_codes


def test_a_blocked_setup_waits_for_the_recovery_band() -> None:
    engine = _engine(**STABLE)
    snapshot, history = _ready(engine)
    for seconds in (2, 4, 6, 8):
        _orb(engine, snapshot, history, seconds=seconds, spread_pct=1.0)
    # Back under the 0.25% limit but above 80% of it: still held out.
    held = _orb(engine, snapshot, history, seconds=10, spread_pct=0.22)
    assert held.state == "INACTIVE"
    assert "SPREAD_RECOVERING" in held.reason_codes
    released = _orb(engine, snapshot, history, seconds=12, spread_pct=0.1)
    assert released.state == "FORMING"
    assert "SPREAD_RECOVERING" not in released.reason_codes


def test_a_forming_setup_does_not_become_ready_on_a_wide_quote() -> None:
    engine = _engine(**STABLE)
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    base, breakout, retest = _orb_bars(snapshot.opening_range.high)
    assert _orb(engine, snapshot, [*base, breakout]).state == "FORMING"
    waiting = _orb(engine, snapshot, [*base, breakout, retest], spread_pct=1.0)
    assert waiting.state == "FORMING"
    assert "WAITING_FOR_SPREAD" in waiting.reason_codes
    assert _orb(engine, snapshot, [*base, breakout, retest], seconds=2).state == "READY"


def test_tick_floor_allows_three_ticks_on_a_low_priced_symbol() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    base, breakout, retest = _orb_bars(snapshot.opening_range.high)
    history = [*base, breakout, retest]
    # $11.50 with a three-cent spread is 0.26%, one tick above a 0.25% limit.
    low_price = {"price": 11.5, "spread_pct": 0.03 / 11.5 * 100}
    at = history[-1].end
    legacy = _engine(spreadConfirmQuotes=1)
    floor = _engine(spreadMinTicks=3)
    legacy_value = next(v for v in legacy.evaluate(snapshot.model_copy(update={"timestamp": at, **low_price}), history)[0] if v.strategy == "ORB_RETEST")
    floor_value = next(v for v in floor.evaluate(snapshot.model_copy(update={"timestamp": at, **low_price}), history)[0] if v.strategy == "ORB_RETEST")
    assert "SPREAD_TOO_WIDE" in legacy_value.reason_codes
    assert "SPREAD_TOO_WIDE" not in floor_value.reason_codes
