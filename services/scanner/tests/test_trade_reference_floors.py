from app.models import FeatureLevel, StrategyParameters
from app.strategies.base import StrategyMemory
from app.strategies.prior_day_high_breakout import PriorDayHighBreakoutStrategy
from test_feature_engine import quote, warmed_engine


def _snapshot(price: float, resistance: float | None, spread: float = 0.02, atr: float = 2.0):
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    level = FeatureLevel(price=resistance, type="SWING_HIGH", strength=1, tests=1, age_bars=5) if resistance is not None else None
    return snapshot.model_copy(update={
        "price": price, "spread_absolute": spread, "atr_14": atr,
        "nearest_resistance": level, "nearest_support": None,
    })


def _references(parameters: dict, price=100.0, stop=99.8, resistance=100.1, spread=0.02, atr=2.0):
    memory = StrategyMemory()
    memory.stop_level = stop
    snapshot = _snapshot(price, resistance, spread, atr)
    values = PriorDayHighBreakoutStrategy().trade_references(memory, snapshot, None, "READY", StrategyParameters.model_validate(parameters))
    return values, memory


def test_defaults_keep_the_structural_stop_and_nearest_resistance() -> None:
    (entry, stop, target), memory = _references({})
    assert (entry, stop) == (100.0, 99.8)
    assert target == 100.1
    assert memory.stop_floored is False


def test_atr_floor_widens_a_tight_stop() -> None:
    (entry, stop, _), memory = _references({"stopMinAtrFraction": 0.25})
    assert stop == entry - 0.5
    assert memory.stop_floored is True


def test_spread_floor_uses_the_quoted_spread() -> None:
    (entry, stop, _), _ = _references({"stopMinSpreads": 20}, spread=0.05)
    assert stop == entry - 1.0


def test_a_wider_structural_stop_is_kept() -> None:
    (_, stop, _), memory = _references({"stopMinAtrFraction": 0.05})
    assert stop == 99.8
    assert memory.stop_floored is False


def test_close_resistance_is_replaced_by_the_minimum_r_target() -> None:
    (entry, stop, target), _ = _references({"stopMinAtrFraction": 0.25, "targetMinR": 1.5})
    assert target == entry + 1.5 * (entry - stop)


def test_distant_resistance_is_kept_as_the_target() -> None:
    (_, _, target), _ = _references({"targetMinR": 1.0}, resistance=101.0)
    assert target == 101.0
