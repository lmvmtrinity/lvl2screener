from datetime import timedelta

from ..models import FeatureSnapshot, StrategyParameters, StrategyState
from ..scoring import ScoreRule
from .base import BaseStrategy, StrategyContext, StrategyMemory, completed_bars, ensure_setup_instance, volume_confirmed


class BullFlagStrategy(BaseStrategy):
    key = "BULL_FLAG"
    name = "Bull Flag"
    description = "ATR-normalized impulse, controlled low-volume pullback, and volume-confirmed continuation."
    use_two_r_target = True
    score_rules = (
        ScoreRule("BULL_FLAG_PULLBACK_CONTROLLED", "pattern", 12, "Pullback stayed inside the retracement limit on contracting volume"),
        ScoreRule("BULL_FLAG_BREAKOUT_PENDING", "pattern", 5, "Flag is waiting for its continuation bar"),
        ScoreRule("BULL_FLAG_CONFIRMED", "pattern", 25, "Completed bar broke the flag high"),
        ScoreRule("BREAKOUT_VOLUME_CONFIRMED", "confirmation", 20, "Continuation candle met the configured volume ratio"),
    )

    def next_state(self, memory: StrategyMemory, f: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters, base: list[str]) -> tuple[StrategyState, list[str]]:
        if not f.atr_14:
            return "INACTIVE", [*base, "ATR_UNAVAILABLE"]
        bars = completed_bars(context, f)
        if len(bars) < max(5, parameters.flag_duration_bars_min + 4):
            return "INACTIVE", [*base, "BULL_FLAG_HISTORY_INCOMPLETE"]
        latest = bars[-1]
        if memory.state == "READY" and memory.stop_level is not None and latest.close < memory.stop_level:
            return "INVALIDATED", [*base, "BULL_FLAG_SUPPORT_LOST"]
        if memory.pullback_at and latest.end > memory.pullback_at:
            if f.timestamp - memory.pullback_at > timedelta(minutes=parameters.setup_timeout_minutes):
                return "EXPIRED", [*base, "BULL_FLAG_TIMEOUT"]
            if memory.stop_level is not None and latest.close < memory.stop_level:
                return "INVALIDATED", [*base, "BULL_FLAG_SUPPORT_LOST"]
            if memory.setup_level is not None and latest.close > memory.setup_level and volume_confirmed(bars, parameters.breakout_volume_ratio_min):
                memory.breakout_at = latest.end
                ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.pullback_at.isoformat()}")
                return "READY", [*base, "BULL_FLAG_CONFIRMED", "BREAKOUT_VOLUME_CONFIRMED"]
            return "FORMING", [*base, "BULL_FLAG_PULLBACK_CONTROLLED", "BULL_FLAG_BREAKOUT_PENDING"]

        max_possible_flag = len(bars) - 4
        if max_possible_flag < parameters.flag_duration_bars_min:
            return "WATCH", [*base, "WAITING_FOR_BULL_FLAG"]

        candidate_match = None
        for flag_length in range(
            parameters.flag_duration_bars_min,
            min(parameters.flag_duration_bars_max, max_possible_flag) + 1,
        ):
            impulse = bars[-(flag_length + 4):-(flag_length + 1)]
            flag = bars[-(flag_length + 1):-1]
            pole_low = min(bar.low for bar in impulse)
            pole_high = max(bar.high for bar in impulse)
            pole = pole_high - pole_low
            directional_advance = impulse[-1].close - impulse[0].open
            directional_slope = directional_advance / f.atr_14 / len(impulse)
            bullish_impulse = (
                directional_advance > 0
                and directional_advance >= pole * 0.5
                and pole / f.atr_14 >= parameters.flagpole_min_atr
                and directional_slope >= parameters.flagpole_min_slope_atr_per_bar
            )
            retracement_floor = pole_high - pole * parameters.flag_retracement_max_pct / 100
            controlled = bool(flag) and min(bar.low for bar in flag) >= retracement_floor
            flag_avg_volume = sum(bar.volume for bar in flag) / len(flag) if flag else 0
            impulse_avg_volume = sum(bar.volume for bar in impulse) / len(impulse)
            contracting = bool(flag) and flag_avg_volume <= impulse_avg_volume * parameters.volume_contraction_max_pct / 100
            breakout_level = max(pole_high, max(bar.high for bar in flag))

            if bullish_impulse and controlled and contracting:
                is_breakout = latest.close > breakout_level and volume_confirmed(bars, parameters.breakout_volume_ratio_min)
                candidate_match = (flag_length, is_breakout, breakout_level, min(bar.low for bar in flag))
                break

        if candidate_match is not None:
            _, is_breakout, breakout_level, stop_level = candidate_match
            if is_breakout:
                memory.breakout_at = latest.end
                memory.setup_level = breakout_level
                memory.stop_level = stop_level
                ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.breakout_at.isoformat()}")
                return "READY", [*base, "BULL_FLAG_CONFIRMED", "BREAKOUT_VOLUME_CONFIRMED"]
            memory.pullback_at = latest.end
            memory.setup_level = breakout_level
            memory.stop_level = stop_level
            ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.pullback_at.isoformat()}")
            return "FORMING", [*base, "BULL_FLAG_PULLBACK_CONTROLLED", "BULL_FLAG_BREAKOUT_PENDING"]

        return "WATCH", [*base, "WAITING_FOR_BULL_FLAG"]
