from datetime import timedelta

from ..models import FeatureSnapshot, StrategyParameters, StrategyState
from ..scoring import ScoreRule
from .base import BaseStrategy, StrategyContext, StrategyMemory, completed_bars, ensure_setup_instance


class VwapReclaimStrategy(BaseStrategy):
    key = "VWAP_RECLAIM"
    name = "VWAP Reclaim"
    description = "A completed-bar reclaim of session VWAP followed by a hold above it."
    use_two_r_target = True
    score_rules = (
        ScoreRule("NEAR_VWAP", "pattern", 6, "Price is within reclaim tolerance of VWAP"),
        ScoreRule("VWAP_RECLAIM_CONFIRMED", "pattern", 19, "Completed bar reclaimed session VWAP"),
        ScoreRule("VWAP_RECLAIM_HOLD_PENDING", "pattern", 6, "Reclaim is waiting for its hold bar"),
        ScoreRule("VWAP_RECLAIM_HELD", "confirmation", 20, "Reclaim held above VWAP on the following bar"),
    )

    def next_state(self, memory: StrategyMemory, f: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters, base: list[str]) -> tuple[StrategyState, list[str]]:
        completed_vwap = f.completed_bar_vwap
        if completed_vwap is None:
            return "INACTIVE", [*base, "COMPLETED_BAR_VWAP_UNAVAILABLE"]
        if f.vwap is None:
            return "INACTIVE", [*base, "VWAP_UNAVAILABLE"]
        bars = completed_bars(context, f)
        latest = bars[-1] if bars else None
        tolerance = completed_vwap * parameters.retest_tolerance_pct / 100
        if memory.pullback_at and f.timestamp - memory.pullback_at > timedelta(minutes=parameters.setup_timeout_minutes) and memory.state != "READY":
            return "EXPIRED", [*base, "VWAP_RECLAIM_TIMEOUT"]
        if latest and latest.close < completed_vwap - tolerance:
            return ("INVALIDATED" if memory.state in ("FORMING", "READY") else "WATCH"), [*base, "VWAP_RECLAIM_FAILED"]
        if memory.pullback_at and latest and latest.end > memory.pullback_at:
            if latest.close > completed_vwap and latest.low >= completed_vwap - tolerance:
                memory.stop_level = completed_vwap - tolerance
                return "READY", [*base, "VWAP_RECLAIM_CONFIRMED", "VWAP_RECLAIM_HELD"]
            return "FORMING", [*base, "VWAP_RECLAIM_CONFIRMED", "VWAP_RECLAIM_HOLD_PENDING"]
        if f.vwap_reclaim and latest:
            memory.pullback_at = latest.end
            memory.setup_level = completed_vwap
            ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{memory.pullback_at.isoformat()}")
            return "FORMING", [*base, "VWAP_RECLAIM_CONFIRMED", "VWAP_RECLAIM_HOLD_PENDING"]
        if f.price <= completed_vwap + tolerance:
            return "WATCH", [*base, "NEAR_VWAP", "WAITING_FOR_VWAP_RECLAIM"]
        return "WATCH", [*base, "WAITING_FOR_VWAP_RECLAIM"]
