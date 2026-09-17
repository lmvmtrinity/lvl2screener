from uuid import UUID

from app.models import OpeningRangeFeature, ScannerProfileConfig, StrategyParameters
from app.strategies.base import min_tick
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, warmed_engine
from test_strategy_engine import bar


def _profile() -> ScannerProfileConfig:
    return ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000f1"), profile_name="ORB Low Price Test",
        strategy="ORB_RETEST", config_version="phase5-tick-test", parameters=StrategyParameters(),
    )


def test_min_tick_is_half_a_cent_below_fifty_cents_and_a_cent_at_or_above() -> None:
    assert min_tick(0.10) == 0.005
    assert min_tick(0.499) == 0.005
    assert min_tick(0.5) == 0.01
    assert min_tick(25) == 0.01


def _low_price_snapshot(timestamp, price: float):
    opening = OpeningRangeFeature(high=.30, low=.28, mid=.29, width=.02, width_pct=(.02 / .29 * 100), width_atr=None, volume=300, complete=True)
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    return snapshot.model_copy(update={"timestamp": timestamp, "price": price, "opening_range": opening})


def _low_price_bars(latest_close: float):
    baseline = [bar(3, .29, .295, .285, .29, 100), bar(4, .29, .295, .285, .29, 100), bar(5, .29, .30, .285, .295, 100)]
    latest = bar(6, .295, latest_close + .002, .29, latest_close, 200)
    return baseline, latest


def test_orb_retest_uses_a_half_cent_buffer_below_fifty_cents() -> None:
    baseline, latest = _low_price_bars(.304)
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    result = engine.evaluate(_low_price_snapshot(latest.end, latest.close), [*baseline, latest])[0]
    orb = next(value for value in result if value.strategy == "ORB_RETEST")
    assert orb.state != "FORMING"
    assert orb.setup_instance_id is None


def test_orb_retest_confirms_breakout_once_it_clears_the_half_cent_buffer() -> None:
    baseline, latest = _low_price_bars(.307)
    engine = StrategyEngine()
    engine.configure_profiles([_profile()])

    result = engine.evaluate(_low_price_snapshot(latest.end, latest.close), [*baseline, latest])[0]
    orb = next(value for value in result if value.strategy == "ORB_RETEST")
    assert orb.state == "FORMING"
    assert orb.setup_instance_id is not None
