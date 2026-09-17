from datetime import datetime, timedelta

from ..models import CandleRecord, FeatureSnapshot, StrategyParameters, StrategyState
from ..scoring import ScoreRule
from .base import (
    BaseStrategy,
    StrategyContext,
    StrategyMemory,
    breakout_buffer,
    completed_bars,
    ensure_setup_instance,
    volume_confirmed,
)
from ..feature_indicators import is_rejection_candle, volume_contraction_ratio


def _is_confirmed_breakout(bars: list[CandleRecord], level: float, parameters: StrategyParameters) -> bool:
    if not bars:
        return False
    bar = bars[-1]
    buffer = breakout_buffer(level, parameters)
    return bar.close > level + buffer and volume_confirmed(bars, parameters.breakout_volume_ratio_min)


class OrbRetestStrategy(BaseStrategy):
    key = "ORB_RETEST"
    name = "Opening Range Breakout Retest"
    description = "Breakout above the completed opening range followed by a supported retest."
    score_rules = (
        ScoreRule("NEAR_OPENING_RANGE_HIGH", "pattern", 7, "Price is coiled at the opening range high"),
        ScoreRule("ORB_BREAKOUT_CONFIRMED", "pattern", 18, "Volume-confirmed close above the opening range high"),
        ScoreRule("ORB_RETEST_IN_PROGRESS", "pattern", 7, "Breakout level is being retested"),
        ScoreRule("ORB_RETEST_CONFIRMED", "confirmation", 20, "Retest held the opening range high on a completed bar"),
    )

    def next_state(self, memory: StrategyMemory, f: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters, base: list[str]) -> tuple[StrategyState, list[str]]:
        opening = f.opening_range
        if opening is None or not opening.complete:
            return "INACTIVE", [*base, "OPENING_RANGE_INCOMPLETE"]
        tolerance = opening.high * (parameters.retest_tolerance_pct / 100)
        completed = completed_bars(context, f)
        latest = completed[-1] if completed else None
        if memory.breakout_at and f.timestamp - memory.breakout_at > timedelta(minutes=parameters.setup_timeout_minutes) and memory.state != "READY":
            return "EXPIRED", [*base, "ORB_RETEST_TIMEOUT"]
        if parameters.retest_volume_contraction_enabled or parameters.retest_high_break_enabled or parameters.retest_rejection_enabled:
            return self._experimental_retest(memory, f, context, parameters, base, opening.high, tolerance, completed)
        if memory.breakout_at and latest and latest.end > memory.breakout_at:
            if latest.close < opening.high - tolerance:
                return "INVALIDATED", [*base, "ORB_SUPPORT_LOST"]
            if latest.low <= opening.high + tolerance and latest.close >= opening.high:
                memory.last_bar_end = latest.end
                memory.stop_level = opening.high - tolerance
                return "READY", [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_CONFIRMED"]
            return "FORMING", [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS"]
        if latest:
            prior = completed[-2] if len(completed) > 1 else None
            if _is_confirmed_breakout(completed, opening.high, parameters):
                memory.breakout_at = latest.end
                memory.last_bar_end = latest.end
                memory.setup_level = opening.high
                memory.impulse_start_at = latest.start
                memory.impulse_end_at = latest.end
                memory.impulse_mean_volume = float(latest.volume)
                ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.breakout_at.isoformat()}")
                return "FORMING", [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS"]
            if prior and _is_confirmed_breakout(completed[:-1], opening.high, parameters):
                memory.breakout_at = prior.end
                memory.setup_level = opening.high
                memory.impulse_start_at = prior.start
                memory.impulse_end_at = prior.end
                memory.impulse_mean_volume = float(prior.volume)
                ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.breakout_at.isoformat()}")
                return "FORMING", [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS"]
        near = abs(f.price - opening.high) / opening.high <= .01
        return ("WATCH", [*base, "NEAR_OPENING_RANGE_HIGH"] if near else [*base, "WAITING_FOR_ORB_BREAKOUT"])

    def _experimental_retest(
        self,
        memory: StrategyMemory,
        f: FeatureSnapshot,
        context: StrategyContext,
        parameters: StrategyParameters,
        base: list[str],
        level: float,
        tolerance: float,
        completed: list[CandleRecord],
    ) -> tuple[StrategyState, list[str]]:
        latest = completed[-1] if completed else None
        if memory.breakout_at and latest and latest.end > memory.breakout_at:
            # Invalidation is evaluated before any confirmation predicate.
            if latest.close < level - tolerance:
                return "INVALIDATED", [*base, "ORB_SUPPORT_LOST"]
            # A confirmed formation remains READY across identical rescans and
            # benign later bars. Only the explicit invalidation/expiry paths
            # may retire it; otherwise state transitions would depend on scan
            # frequency rather than completed-bar history.
            if memory.state == "READY":
                reasons = [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_CONFIRMED"]
                if memory.retest_volume_ratio is not None:
                    reasons.append("RETEST_VOLUME_CONTRACTED")
                if memory.support_rejection_confirmed:
                    reasons.append("SUPPORT_REJECTION_CONFIRMED")
                return "READY", reasons
            if memory.retest_bar_end is None:
                if latest.low > level + tolerance or latest.close < level:
                    return "FORMING", [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS"]
                memory.retest_bar_end = latest.end
                memory.retest_bar_high = latest.high
                memory.retest_bar_low = latest.low
                pullback_bars = self._pullback_bars(memory, completed, latest.end)
                memory.pullback_volume_sum = sum(bar.volume for bar in pullback_bars)
                memory.pullback_volume_count = len(pullback_bars)
                memory.stop_level = level - tolerance
                # ORB normally binds this at breakout. Reassert that invariant
                # when the retest becomes concrete, before optional gates can
                # reject it, so the terminal evidence remains attributable.
                ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.breakout_at.isoformat()}")
                if parameters.retest_volume_contraction_enabled:
                    ratio = volume_contraction_ratio(pullback_bars, self._impulse_bars(memory, completed))
                    if ratio is None:
                        memory.retest_volume_unavailable = True
                        return "FORMING", [*base, "ORB_BREAKOUT_CONFIRMED", "RETEST_VOLUME_UNAVAILABLE"]
                    memory.retest_volume_ratio = ratio
                    if ratio > parameters.retest_volume_contraction_max_ratio:
                        return "INVALIDATED", [*base, "ORB_BREAKOUT_CONFIRMED", "RETEST_VOLUME_NOT_CONTRACTED"]
                if parameters.retest_rejection_enabled:
                    memory.support_rejection_confirmed = is_rejection_candle(
                        latest,
                        level,
                        lower_wick_body_min=parameters.rejection_lower_wick_body_min,
                        upper_wick_range_max_pct=parameters.rejection_upper_wick_range_max_pct,
                        close_location_min_pct=parameters.rejection_close_location_min_pct,
                    )
                    if not memory.support_rejection_confirmed:
                        return "INVALIDATED", [*base, "ORB_BREAKOUT_CONFIRMED", "SUPPORT_REJECTION_NOT_CONFIRMED"]
                if parameters.retest_high_break_enabled or parameters.retest_rejection_enabled:
                    reasons = [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS"]
                    if memory.retest_volume_ratio is not None:
                        reasons.append("RETEST_VOLUME_CONTRACTED")
                    if memory.support_rejection_confirmed:
                        reasons.append("SUPPORT_REJECTION_CONFIRMED")
                        reasons.append("SUPPORT_REJECTION_CONFIRMATION_PENDING")
                    if parameters.retest_high_break_enabled:
                        reasons.append("RETEST_HIGH_BREAK_PENDING")
                    return "FORMING", reasons
                reasons = [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_CONFIRMED"]
                if memory.retest_volume_ratio is not None:
                    reasons.append("RETEST_VOLUME_CONTRACTED")
                return "READY", reasons

            if latest.end > memory.retest_bar_end:
                if parameters.retest_volume_contraction_enabled and memory.retest_volume_unavailable:
                    reasons = [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS", "RETEST_VOLUME_UNAVAILABLE"]
                    if parameters.retest_high_break_enabled:
                        reasons.append("RETEST_HIGH_BREAK_PENDING")
                    if memory.support_rejection_confirmed:
                        reasons.append("SUPPORT_REJECTION_CONFIRMED")
                        reasons.append("SUPPORT_REJECTION_CONFIRMATION_PENDING")
                    return "FORMING", reasons
                confirmation_level = (memory.retest_bar_high or level) + breakout_buffer(level, parameters)
                high_break_confirmed = (
                    not parameters.retest_high_break_enabled
                    or latest.close > confirmation_level
                )
                rejection_confirmed = (
                    not parameters.retest_rejection_enabled
                    or latest.close >= level
                )
                if high_break_confirmed and rejection_confirmed:
                    reasons = [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_CONFIRMED"]
                    if memory.retest_volume_ratio is not None:
                        reasons.append("RETEST_VOLUME_CONTRACTED")
                    if memory.support_rejection_confirmed:
                        reasons.append("SUPPORT_REJECTION_CONFIRMED")
                    return "READY", reasons
            reasons = [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS"]
            if parameters.retest_volume_contraction_enabled and memory.retest_volume_unavailable:
                reasons.append("RETEST_VOLUME_UNAVAILABLE")
            if memory.retest_volume_ratio is not None:
                reasons.append("RETEST_VOLUME_CONTRACTED")
            if memory.support_rejection_confirmed:
                reasons.append("SUPPORT_REJECTION_CONFIRMED")
                reasons.append("SUPPORT_REJECTION_CONFIRMATION_PENDING")
            if parameters.retest_high_break_enabled:
                reasons.append("RETEST_HIGH_BREAK_PENDING")
            return "FORMING", reasons
        if latest and _is_confirmed_breakout(completed, level, parameters):
            memory.breakout_at = latest.end
            memory.last_bar_end = latest.end
            memory.setup_level = level
            memory.impulse_start_at = latest.start
            memory.impulse_end_at = latest.end
            memory.impulse_mean_volume = float(latest.volume)
            ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.breakout_at.isoformat()}")
            return "FORMING", [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS"]
        if latest:
            prior = completed[-2] if len(completed) > 1 else None
            if prior and _is_confirmed_breakout(completed[:-1], level, parameters):
                memory.breakout_at = prior.end
                memory.setup_level = level
                memory.impulse_start_at = prior.start
                memory.impulse_end_at = prior.end
                memory.impulse_mean_volume = float(prior.volume)
                ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.breakout_at.isoformat()}")
                return "FORMING", [*base, "ORB_BREAKOUT_CONFIRMED", "ORB_RETEST_IN_PROGRESS"]
        if abs(f.price - level) / level <= .01:
            return "WATCH", [*base, "NEAR_OPENING_RANGE_HIGH"]
        return "WATCH", [*base, "WAITING_FOR_ORB_BREAKOUT"]

    @staticmethod
    def _impulse_bars(memory: StrategyMemory, completed: list[CandleRecord]) -> list[CandleRecord]:
        if memory.impulse_end_at is None:
            return []
        return [bar for bar in completed if bar.end == memory.impulse_end_at]

    @staticmethod
    def _pullback_bars(
        memory: StrategyMemory,
        completed: list[CandleRecord],
        through: datetime,
    ) -> list[CandleRecord]:
        if memory.impulse_end_at is None:
            return []
        return [
            bar
            for bar in completed
            if memory.impulse_end_at < bar.end <= through
        ]
