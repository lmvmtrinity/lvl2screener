from datetime import timedelta

from ..models import CandleRecord, FeatureSnapshot, StrategyParameters, StrategyState
from ..scoring import ScoreRule
from .base import BaseStrategy, StrategyContext, StrategyMemory, breakout_buffer, completed_bars, ensure_setup_instance
from ..feature_indicators import is_rejection_candle, volume_contraction_ratio


class VwapHoldStrategy(BaseStrategy):
    key = "VWAP_HOLD"
    name = "VWAP Hold"
    description = "Bullish structure that pulls back to VWAP and confirms the hold."
    score_rules = (
        ScoreRule("ABOVE_VWAP", "pattern", 8, "Price is working above session VWAP"),
        ScoreRule("VWAP_TOUCH_CONFIRMED", "pattern", 10, "Pullback tagged VWAP and closed back above it"),
        ScoreRule("VWAP_HOLD_IN_PROGRESS", "pattern", 7, "Hold is forming above VWAP"),
        ScoreRule("VWAP_HOLD_CONFIRMED", "confirmation", 20, "Completed bar confirmed the VWAP hold"),
    )

    def next_state(self, memory: StrategyMemory, f: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters, base: list[str]) -> tuple[StrategyState, list[str]]:
        completed_vwap = f.completed_bar_vwap
        if completed_vwap is None:
            return "INACTIVE", [*base, "COMPLETED_BAR_VWAP_UNAVAILABLE"]
        if f.vwap is None:
            return "INACTIVE", [*base, "VWAP_UNAVAILABLE"]
        tolerance = completed_vwap * (parameters.retest_tolerance_pct / 100)
        completed = completed_bars(context, f)
        latest = completed[-1] if completed else None
        if memory.pullback_at and f.timestamp - memory.pullback_at > timedelta(minutes=parameters.setup_timeout_minutes) and memory.state != "READY":
            return "EXPIRED", [*base, "VWAP_HOLD_TIMEOUT"]
        experimental = parameters.retest_volume_contraction_enabled or parameters.retest_high_break_enabled or parameters.retest_rejection_enabled
        if experimental:
            return self._experimental_hold(memory, f, context, parameters, base, completed_vwap, tolerance, completed)
        if latest and latest.close < completed_vwap - tolerance:
            return ("INVALIDATED" if memory.state in ("FORMING", "READY") else "WATCH"), [*base, "VWAP_LOST"]
        if memory.pullback_at and latest and latest.end > memory.pullback_at:
            prior = completed[-2] if len(completed) > 1 else None
            confirmed = latest.close > completed_vwap and (f.vwap_rejection or (prior is not None and latest.close > prior.high) or latest.low > (prior.low if prior else latest.low))
            if confirmed:
                memory.stop_level = completed_vwap - tolerance
                return "READY", [*base, "ABOVE_VWAP", "VWAP_HOLD_CONFIRMED"]
            return "FORMING", [*base, "ABOVE_VWAP", "VWAP_HOLD_IN_PROGRESS"]
        bullish = latest is not None and latest.close > completed_vwap and f.last_3_closes_above_vwap >= 2
        if bullish and latest and latest.low <= completed_vwap + tolerance and latest.close >= completed_vwap:
            memory.pullback_at = latest.end
            memory.impulse_start_at = completed[-4].start if len(completed) >= 4 else None
            memory.impulse_end_at = completed[-2].end if len(completed) >= 4 else None
            memory.impulse_mean_volume = (sum(bar.volume for bar in completed[-4:-1]) / 3) if len(completed) >= 4 else None
            ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.pullback_at.isoformat()}")
            return "FORMING", [*base, "ABOVE_VWAP", "VWAP_TOUCH_CONFIRMED", "VWAP_HOLD_IN_PROGRESS"]
        return ("WATCH", [*base, "ABOVE_VWAP"] if bullish else [*base, "WAITING_FOR_VWAP_STRUCTURE"])

    def _experimental_hold(
        self,
        memory: StrategyMemory,
        f: FeatureSnapshot,
        context: StrategyContext,
        parameters: StrategyParameters,
        base: list[str],
        support: float,
        tolerance: float,
        completed: list[CandleRecord],
    ) -> tuple[StrategyState, list[str]]:
        latest = completed[-1] if completed else None
        if latest and memory.setup_level is not None and latest.close < memory.setup_level - tolerance:
            return "INVALIDATED", [*base, "VWAP_LOST"]
        if memory.pullback_at:
            later = latest is not None and latest.end > memory.pullback_at
            prior = completed[-2] if len(completed) > 1 else None
            # Every experimental variant first retains the baseline hold
            # confirmation. The optional gates must not make the touch bar an
            # earlier entry merely because a volume filter was turned on.
            baseline_hold_confirmed = (
                later
                and latest is not None
                and latest.close > support
                and (
                    f.vwap_rejection
                    or (prior is not None and latest.close > prior.high)
                    or latest.low > (prior.low if prior else latest.low)
                )
            )
            if parameters.retest_volume_contraction_enabled and memory.retest_volume_unavailable:
                reasons = [*base, "ABOVE_VWAP", "VWAP_HOLD_IN_PROGRESS", "RETEST_VOLUME_UNAVAILABLE"]
                if parameters.retest_high_break_enabled:
                    reasons.append("RETEST_HIGH_BREAK_PENDING")
                if memory.support_rejection_confirmed:
                    reasons.append("SUPPORT_REJECTION_CONFIRMED")
                    reasons.append("SUPPORT_REJECTION_CONFIRMATION_PENDING")
                return "FORMING", reasons
            high_break_confirmed = (
                not parameters.retest_high_break_enabled
                or (
                    later
                    and latest is not None
                    and latest.close
                    > (memory.retest_bar_high or support) + breakout_buffer(support, parameters)
                )
            )
            rejection_confirmation = (
                not parameters.retest_rejection_enabled
                or (later and latest is not None and latest.close >= support)
            )
            if baseline_hold_confirmed and high_break_confirmed and rejection_confirmation:
                reasons = [*base, "ABOVE_VWAP", "VWAP_HOLD_CONFIRMED"]
                if memory.retest_volume_ratio is not None:
                    reasons.append("RETEST_VOLUME_CONTRACTED")
                if memory.support_rejection_confirmed:
                    reasons.append("SUPPORT_REJECTION_CONFIRMED")
                return "READY", reasons
            reasons = [*base, "ABOVE_VWAP", "VWAP_HOLD_IN_PROGRESS"]
            if memory.retest_volume_ratio is not None:
                reasons.append("RETEST_VOLUME_CONTRACTED")
            if memory.support_rejection_confirmed:
                reasons.append("SUPPORT_REJECTION_CONFIRMED")
                reasons.append("SUPPORT_REJECTION_CONFIRMATION_PENDING")
            if parameters.retest_high_break_enabled:
                reasons.append("RETEST_HIGH_BREAK_PENDING")
            return "FORMING", reasons

        bullish = latest is not None and latest.close > support and f.last_3_closes_above_vwap >= 2
        if not bullish or latest is None or latest.low > support + tolerance or latest.close < support:
            return "WATCH", [*base, "ABOVE_VWAP"] if bullish else [*base, "WAITING_FOR_VWAP_STRUCTURE"]
        if len(completed) < 4:
            return "WATCH", [*base, "RETEST_VOLUME_UNAVAILABLE"] if parameters.retest_volume_contraction_enabled else [*base, "WAITING_FOR_VWAP_STRUCTURE"]
        impulse = completed[-4:-1]
        if impulse[-1].close <= impulse[0].close:
            return "WATCH", [*base, "VWAP_IMPULSE_UNAVAILABLE"]
        memory.pullback_at = latest.end
        memory.setup_level = support
        memory.impulse_start_at = impulse[0].start
        memory.impulse_end_at = impulse[-1].end
        memory.impulse_mean_volume = sum(bar.volume for bar in impulse) / len(impulse)
        memory.retest_bar_end = latest.end
        memory.retest_bar_high = latest.high
        memory.retest_bar_low = latest.low
        memory.pullback_volume_sum = float(latest.volume)
        memory.pullback_volume_count = 1
        memory.stop_level = support - tolerance
        # The touch has selected all of its formation inputs. Bind its stable
        # identity before optional gates so an evidence-bearing rejection is
        # attributable to this concrete formation.
        ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.pullback_at.isoformat()}")
        if parameters.retest_volume_contraction_enabled:
            ratio = volume_contraction_ratio([latest], impulse)
            if ratio is None:
                memory.retest_volume_unavailable = True
                return "FORMING", [*base, "ABOVE_VWAP", "VWAP_TOUCH_CONFIRMED", "RETEST_VOLUME_UNAVAILABLE"]
            memory.retest_volume_ratio = ratio
            if ratio > parameters.retest_volume_contraction_max_ratio:
                return "INVALIDATED", [*base, "ABOVE_VWAP", "VWAP_TOUCH_CONFIRMED", "RETEST_VOLUME_NOT_CONTRACTED"]
        if parameters.retest_rejection_enabled:
            memory.support_rejection_confirmed = is_rejection_candle(
                latest,
                support,
                lower_wick_body_min=parameters.rejection_lower_wick_body_min,
                upper_wick_range_max_pct=parameters.rejection_upper_wick_range_max_pct,
                close_location_min_pct=parameters.rejection_close_location_min_pct,
            )
            if not memory.support_rejection_confirmed:
                return "INVALIDATED", [*base, "VWAP_TOUCH_CONFIRMED", "SUPPORT_REJECTION_NOT_CONFIRMED"]
        # The touch is never a hold confirmation. This preserves the baseline
        # later-bar timing even for the volume-only experiment.
        reasons = [*base, "ABOVE_VWAP", "VWAP_TOUCH_CONFIRMED", "VWAP_HOLD_IN_PROGRESS"]
        if memory.retest_volume_ratio is not None:
            reasons.append("RETEST_VOLUME_CONTRACTED")
        if memory.support_rejection_confirmed:
            reasons.append("SUPPORT_REJECTION_CONFIRMED")
            reasons.append("SUPPORT_REJECTION_CONFIRMATION_PENDING")
        if parameters.retest_high_break_enabled:
            reasons.append("RETEST_HIGH_BREAK_PENDING")
        return "FORMING", reasons
