from datetime import timedelta

from ..models import FeatureSnapshot, StrategyParameters, StrategyState
from ..scoring import ScoreRule
from .base import BaseStrategy, StrategyContext, StrategyMemory, breakout_buffer, completed_bars, ensure_setup_instance, volume_confirmed


class PriorDayHighBreakoutStrategy(BaseStrategy):
    key = "PRIOR_DAY_HIGH_BREAKOUT"
    name = "Prior-Day-High Breakout"
    description = "Volume-confirmed close through the previous completed daily session high."
    use_two_r_target = True
    score_rules = (
        ScoreRule("NEAR_PRIOR_DAY_HIGH", "pattern", 10, "Price is pressing the prior-day high"),
        ScoreRule("PRIOR_DAY_HIGH_BREAKOUT_PENDING", "pattern", 5, "Breakout attempt is pending"),
        ScoreRule("PRIOR_DAY_HIGH_BREAKOUT_CONFIRMED", "pattern", 25, "Completed bar closed through the prior-day high"),
        ScoreRule("BREAKOUT_VOLUME_CONFIRMED", "confirmation", 20, "Breakout candle met the configured volume ratio"),
    )

    def next_state(self, memory: StrategyMemory, f: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters, base: list[str]) -> tuple[StrategyState, list[str]]:
        level = context.prior_day_high
        if level is None:
            return "INACTIVE", [*base, "PRIOR_DAY_HIGH_UNAVAILABLE"]
        bars = completed_bars(context, f)
        latest = bars[-1] if bars else None
        tolerance = level * parameters.retest_tolerance_pct / 100
        active_formation = memory.setup_instance_id is not None and memory.setup_level is not None and memory.breakout_at is not None
        formation_started_at = memory.breakout_at or memory.pullback_at
        if formation_started_at and f.timestamp - formation_started_at > timedelta(minutes=parameters.setup_timeout_minutes):
            return "EXPIRED", [*base, "PRIOR_DAY_HIGH_BREAKOUT_TIMEOUT"]
        if active_formation and latest and memory.breakout_at is not None and latest.end > memory.breakout_at and latest.close < level - tolerance:
            return "INVALIDATED", [*base, "PRIOR_DAY_HIGH_LOST"]
        if latest and latest.close > level + breakout_buffer(level, parameters) and volume_confirmed(bars, parameters.breakout_volume_ratio_min):
            memory.breakout_at = latest.end
            memory.setup_level = level
            memory.stop_level = level - tolerance
            ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.breakout_at.isoformat()}")
            return "READY", [*base, "PRIOR_DAY_HIGH_BREAKOUT_CONFIRMED", "BREAKOUT_VOLUME_CONFIRMED"]
        distance = (level - f.price) / level * 100
        if active_formation:
            return "WATCH", [*base, "PRIOR_DAY_HIGH_FORMATION_ACTIVE"]
        if -.25 <= distance <= .75:
            if memory.pullback_at is None:
                memory.pullback_at = latest.end if latest else f.timestamp
            memory.setup_level = level
            return "FORMING", [*base, "NEAR_PRIOR_DAY_HIGH", "PRIOR_DAY_HIGH_BREAKOUT_PENDING"]
        memory.pullback_at = None
        return "WATCH", [*base, "WAITING_FOR_PRIOR_DAY_HIGH_BREAKOUT"]
