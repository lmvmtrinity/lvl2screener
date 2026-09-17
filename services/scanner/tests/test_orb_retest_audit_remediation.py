from uuid import UUID

from app.models import CandleRecord, ScannerProfileConfig, StrategyParameters
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, warmed_engine
from test_strategy_engine import bar


def _orb_bars(orh: float) -> tuple[list[CandleRecord], CandleRecord, CandleRecord]:
    base = [
        bar(3, orh - 0.1, orh, orh - 0.2, orh - 0.05, 100),
        bar(4, orh - 0.05, orh, orh - 0.1, orh, 100),
        bar(5, orh, orh + 0.02, orh - 0.05, orh, 100),
    ]
    # High volume breakout (200 volume vs 100 baseline = 2.0x >= 1.5 min)
    breakout = bar(6, orh, orh + 0.3, orh, orh + 0.2, 200)
    retest = bar(7, orh + 0.2, orh + 0.25, orh - 0.05, orh + 0.05, 120)
    return base, breakout, retest


def test_orb_low_volume_prior_breakout_cannot_bypass_confirmation() -> None:
    """F-03: The fallback recognizing a breakout in the previous candle must check volume confirmation."""
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, _, retest = _orb_bars(orh)
    # Breakout with LOW volume: 100 volume vs 100 baseline = 1.0x < 1.5 min
    low_vol_breakout = bar(6, orh, orh + 0.3, orh, orh + 0.2, 100)

    engine = StrategyEngine()

    # Bar 6 (low_vol_breakout): should NOT trigger FORMING
    eval1 = engine.evaluate(
        snapshot.model_copy(update={"timestamp": low_vol_breakout.end, "price": low_vol_breakout.close}),
        [*base, low_vol_breakout],
    )[0]
    orb1 = next(v for v in eval1 if v.strategy == "ORB_RETEST")
    assert orb1.state != "FORMING"
    assert "ORB_BREAKOUT_CONFIRMED" not in orb1.reason_codes

    # Bar 7 (retest bar): prior bar was low_vol_breakout. Must NOT trigger FORMING on prior breakout!
    eval2 = engine.evaluate(
        snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}),
        [*base, low_vol_breakout, retest],
    )[0]
    orb2 = next(v for v in eval2 if v.strategy == "ORB_RETEST")
    assert orb2.state != "FORMING"
    assert orb2.state != "READY"
    assert "ORB_BREAKOUT_CONFIRMED" not in orb2.reason_codes


def test_orb_high_volume_prior_breakout_triggers_forming() -> None:
    """F-03: When prior bar had genuine volume confirmation, recovery triggers FORMING."""
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, retest = _orb_bars(orh)

    # Evaluate with engine starting at bar 7 directly (simulating missed bar 6 tick)
    engine = StrategyEngine()
    eval2 = engine.evaluate(
        snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}),
        [*base, breakout, retest],
    )[0]
    orb2 = next(v for v in eval2 if v.strategy == "ORB_RETEST")
    # Because breakout had volume 200 vs 100 baseline (2.0x >= 1.5), it should recover FORMING
    assert orb2.state == "FORMING"
    assert "ORB_BREAKOUT_CONFIRMED" in orb2.reason_codes


def test_orb_below_vwap_never_emits_above_vwap_reason() -> None:
    """F-03: When price is below VWAP at READY retest, ABOVE_VWAP must NOT be emitted."""
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, retest = _orb_bars(orh)

    engine = StrategyEngine()
    # Progress through breakout to FORMING
    engine.evaluate(
        snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}),
        [*base, breakout],
    )

    # In retest evaluation, force close_above_vwap = False
    eval_ready = engine.evaluate(
        snapshot.model_copy(update={
            "timestamp": retest.end,
            "price": retest.close,
            "close_above_vwap": False,
        }),
        [*base, breakout, retest],
    )[0]
    orb_ready = next(v for v in eval_ready if v.strategy == "ORB_RETEST")
    assert orb_ready.state == "READY"
    assert "ORB_RETEST_CONFIRMED" in orb_ready.reason_codes
    # ABOVE_VWAP MUST NOT be present when below VWAP!
    assert "ABOVE_VWAP" not in orb_ready.reason_codes


def test_orb_above_vwap_emits_above_vwap_reason_from_base() -> None:
    """F-03: When price is genuinely above VWAP, ABOVE_VWAP is emitted from base features."""
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = snapshot.opening_range.high
    base, breakout, retest = _orb_bars(orh)

    engine = StrategyEngine()
    engine.evaluate(
        snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}),
        [*base, breakout],
    )

    eval_ready = engine.evaluate(
        snapshot.model_copy(update={
            "timestamp": retest.end,
            "price": retest.close,
            "close_above_vwap": True,
        }),
        [*base, breakout, retest],
    )[0]
    orb_ready = next(v for v in eval_ready if v.strategy == "ORB_RETEST")
    assert orb_ready.state == "READY"
    assert "ORB_RETEST_CONFIRMED" in orb_ready.reason_codes
    assert "ABOVE_VWAP" in orb_ready.reason_codes


def test_orb_configurable_breakout_buffer_pct() -> None:
    """F-03: Configured breakout_buffer_pct must be respected rather than hardcoded 0.0005."""
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    orh = 100.0  # min_tick is 0.01

    base = [
        bar(3, orh - 0.1, orh, orh - 0.2, orh - 0.05, 100),
        bar(4, orh - 0.05, orh, orh - 0.1, orh, 100),
        bar(5, orh, orh + 0.02, orh - 0.05, orh, 100),
    ]

    # Breakout close is 100.08 (+0.08 above ORH)
    breakout = bar(6, orh, orh + 0.2, orh, 100.08, 200)

    engine = StrategyEngine()
    # With strict buffer of 0.10% (buffer = $0.10): close at 100.08 is NOT a breakout (> 100.10)
    engine.configure_profiles([
        ScannerProfileConfig(
            profile_id=UUID("10000000-0000-4000-8000-000000000099"),
            profile_name="ORB Strict Buffer",
            strategy="ORB_RETEST",
            config_version="v-strict",
            parameters=StrategyParameters(breakout_buffer_pct=0.10),
        )
    ])

    eval1 = engine.evaluate(
        snapshot.model_copy(update={
            "timestamp": breakout.end,
            "price": breakout.close,
            "opening_range": snapshot.opening_range.model_copy(update={"high": orh}),
        }),
        [*base, breakout],
    )[0]
    orb1 = next(v for v in eval1 if v.strategy == "ORB_RETEST")
    assert orb1.state != "FORMING"
