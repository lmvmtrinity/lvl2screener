from datetime import timedelta

from ..models import FeatureSnapshot, StrategyParameters, StrategyState
from ..scoring import ScoreRule
from .base import BaseStrategy, StrategyContext, StrategyMemory, breakout_buffer, completed_bars, ensure_setup_instance, volume_confirmed


class HighOfDayBreakoutStrategy(BaseStrategy):
    key = "HIGH_OF_DAY_BREAKOUT"
    name = "High-of-Day Breakout"
    description = "Volume-confirmed close above a consolidated high established by prior completed intraday bars."
    use_two_r_target = True
    score_rules = (
        ScoreRule("NEAR_HIGH_OF_DAY", "pattern", 10, "Price is pressing the high of the day"),
        ScoreRule("HIGH_OF_DAY_BREAKOUT_PENDING", "pattern", 5, "Breakout attempt is pending"),
        ScoreRule("HIGH_OF_DAY_BREAKOUT_CONFIRMED", "pattern", 25, "Completed bar closed through a consolidated high of the day"),
        ScoreRule("BREAKOUT_VOLUME_CONFIRMED", "confirmation", 20, "Breakout candle met the configured volume ratio"),
    )

    def next_state(self, memory: StrategyMemory, f: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters, base: list[str]) -> tuple[StrategyState, list[str]]:
        bars = completed_bars(context, f)
        if len(bars) < 2:
            return "INACTIVE", [*base, "HIGH_OF_DAY_UNAVAILABLE"]
        latest = bars[-1]
        active_formation = memory.setup_instance_id is not None and memory.setup_level is not None and memory.breakout_at is not None
        level = memory.setup_level if active_formation and memory.setup_level is not None else max(bar.high for bar in bars[:-1])
        tolerance = level * parameters.retest_tolerance_pct / 100
        formation_started_at = memory.breakout_at or memory.pullback_at
        if formation_started_at and f.timestamp - formation_started_at > timedelta(minutes=parameters.setup_timeout_minutes):
            return "EXPIRED", [*base, "HIGH_OF_DAY_BREAKOUT_TIMEOUT"]
        if active_formation and memory.breakout_at is not None and latest.end > memory.breakout_at and latest.close < level - tolerance:
            return "INVALIDATED", [*base, "HIGH_OF_DAY_BREAKOUT_FAILED"]
        prior_bars = bars[:-1]
        base_window = prior_bars[-parameters.consolidation_bars_min:]
        consolidated = len(base_window) >= parameters.consolidation_bars_min and (
            max(candle.high for candle in base_window) - min(candle.low for candle in base_window)
        ) / level * 100 <= parameters.consolidation_range_max_pct
        if latest.close > level + breakout_buffer(level, parameters) and volume_confirmed(bars, parameters.breakout_volume_ratio_min):
            if not consolidated:
                memory.setup_level = level
                memory.pullback_at = None
                return "WATCH", [*base, "HIGH_OF_DAY_CONSOLIDATION_INSUFFICIENT"]
            memory.breakout_at = latest.end
            memory.setup_level = level
            memory.stop_level = level - tolerance
            ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.breakout_at.isoformat()}")
            return "READY", [*base, "HIGH_OF_DAY_BREAKOUT_CONFIRMED", "BREAKOUT_VOLUME_CONFIRMED"]
        distance = (level - f.price) / level * 100
        if active_formation:
            return "WATCH", [*base, "HIGH_OF_DAY_BREAKOUT_FORMATION_ACTIVE"]
        if -.25 <= distance <= .5:
            if memory.pullback_at is None:
                memory.pullback_at = latest.end
            memory.setup_level = level
            return "FORMING", [*base, "NEAR_HIGH_OF_DAY", "HIGH_OF_DAY_BREAKOUT_PENDING"]
        memory.pullback_at = None
        return "WATCH", [*base, "WAITING_FOR_HIGH_OF_DAY_BREAKOUT"]
