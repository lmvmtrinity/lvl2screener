from dataclasses import dataclass
from datetime import datetime, timedelta

from ..feature_indicators import (
    WILDER_RSI_14_VERSION,
    ConfirmedPivotLow,
    confirmed_pivot_lows,
    volume_contraction_ratio,
)
from ..models import CandleRecord, FeatureSnapshot, StrategyParameters, StrategyState
from ..scoring import ScoreRule
from .base import (
    BaseStrategy,
    StrategyContext,
    StrategyMemory,
    breakout_buffer,
    completed_bars,
    ensure_setup_instance,
    min_tick,
)


@dataclass(frozen=True)
class _DivergencePair:
    first: ConfirmedPivotLow
    second: ConfirmedPivotLow
    ratio: float
    key: str


class RsiVwapReclaimStrategy(BaseStrategy):
    key = "RSI_VWAP_RECLAIM"
    indicator_version = WILDER_RSI_14_VERSION
    name = "RSI/VWAP Reclaim"
    description = "Confirmed bullish RSI divergence, then a completed VWAP reclaim, hold, and resistance break."
    score_rules = (
        ScoreRule("RSI_BULLISH_DIVERGENCE_CONFIRMED", "pattern", 16, "Price made a lower confirmed low while sampled RSI made a higher low"),
        ScoreRule("RSI_VWAP_RECLAIM_CONFIRMED", "pattern", 8, "VWAP was reclaimed after divergence confirmation"),
        ScoreRule("RSI_VWAP_HOLD_CONFIRMED", "confirmation", 12, "A later completed bar held above completed-bar VWAP"),
        ScoreRule("RSI_RESISTANCE_BREAK_CONFIRMED", "confirmation", 8, "A later completed bar broke the frozen resistance level"),
    )

    def next_state(
        self,
        memory: StrategyMemory,
        f: FeatureSnapshot,
        context: StrategyContext,
        parameters: StrategyParameters,
        base: list[str],
    ) -> tuple[StrategyState, list[str]]:
        if context.rsi_by_bar is None or context.indicator_version != self.indicator_version:
            return "INACTIVE", [*base, "RSI_INDICATOR_VERSION_UNAVAILABLE"]
        bars = completed_bars(context, f)
        if not bars or not any(value is not None for value in context.rsi_by_bar.values()):
            return "INACTIVE", [*base, "RSI_HISTORY_UNAVAILABLE"]

        if memory.divergence_confirmed_at is not None:
            return self._progress(memory, f, bars, parameters, base)

        pair, unavailable = self._find_pair(memory, bars, context, parameters, f.timestamp)
        if unavailable:
            return "WATCH", [*base, unavailable]
        if pair is None:
            return "WATCH", [*base, "WAITING_FOR_RSI_DIVERGENCE"]

        memory.formation_key = pair.key
        memory.first_pivot_at = pair.first.pivot_bar.end
        memory.first_pivot_price = pair.first.pivot_bar.low
        memory.first_pivot_rsi = pair.first.rsi
        memory.second_pivot_at = pair.second.pivot_bar.end
        memory.second_pivot_price = pair.second.pivot_bar.low
        memory.second_pivot_rsi = pair.second.rsi
        memory.divergence_confirmed_at = pair.second.confirmation_timestamp
        memory.breakout_at = pair.second.confirmation_timestamp
        memory.setup_level = pair.second.pivot_bar.low
        memory.invalidation_level = pair.second.pivot_bar.low
        memory.stop_level = pair.second.pivot_bar.low - breakout_buffer(pair.second.pivot_bar.low, parameters)
        memory.divergence_volume_ratio = pair.ratio
        ensure_setup_instance(memory, f"{f.instrument_id}:{self.key}:{pair.key}")
        return "FORMING", [*base, "RSI_BULLISH_DIVERGENCE_CONFIRMED", "RSI_VWAP_RECLAIM_PENDING"]

    def _progress(
        self,
        memory: StrategyMemory,
        f: FeatureSnapshot,
        bars: list[CandleRecord],
        parameters: StrategyParameters,
        base: list[str],
    ) -> tuple[StrategyState, list[str]]:
        if memory.breakout_at and f.timestamp - memory.breakout_at > timedelta(minutes=parameters.rsi_setup_timeout_minutes) and memory.state != "READY":
            self._retire(memory)
            return "EXPIRED", [*base, "RSI_VWAP_RECLAIM_TIMEOUT"]
        latest = bars[-1] if bars else None
        if latest is None:
            return "FORMING", [*base, "RSI_BULLISH_DIVERGENCE_CONFIRMED", "RSI_VWAP_RECLAIM_PENDING"]

        # Structural invalidation is deliberately checked before reclaim, hold,
        # or resistance advancement on a bar satisfying more than one predicate.
        if memory.invalidation_level is not None and latest.close < memory.invalidation_level:
            self._retire(memory)
            return "INVALIDATED", [*base, "RSI_DIVERGENCE_INVALIDATED"]

        common = [*base, "RSI_BULLISH_DIVERGENCE_CONFIRMED", "RSI_VOLUME_CONTRACTED"]
        if memory.reclaim_at is None:
            if latest.end > (memory.divergence_confirmed_at or latest.end) and f.vwap_reclaim:
                memory.reclaim_at = latest.end
                memory.pullback_at = latest.end
                return "FORMING", [*common, "RSI_VWAP_RECLAIM_CONFIRMED", "RSI_VWAP_HOLD_PENDING"]
            return "FORMING", [*common, "RSI_VWAP_RECLAIM_PENDING"]

        completed_vwap = f.completed_bar_vwap
        if completed_vwap is None:
            return "FORMING", [*common, "RSI_VWAP_RECLAIM_CONFIRMED", "COMPLETED_BAR_VWAP_UNAVAILABLE"]
        tolerance = completed_vwap * parameters.retest_tolerance_pct / 100
        if latest.end > memory.reclaim_at and latest.close < completed_vwap - tolerance:
            self._retire(memory)
            return "INVALIDATED", [*common, "RSI_VWAP_RECLAIM_FAILED"]

        if memory.hold_at is None:
            if latest.end > memory.reclaim_at and latest.close > completed_vwap and latest.low >= completed_vwap - tolerance:
                memory.hold_at = latest.end
                memory.pullback_at = latest.end
                hold_bars = [
                    bar
                    for bar in bars
                    if memory.second_pivot_at is not None
                    and bar.end >= memory.second_pivot_at
                    and bar.end <= latest.end
                ]
                memory.resistance_level = max((bar.high for bar in hold_bars), default=latest.high)
                return "FORMING", [*common, "RSI_VWAP_RECLAIM_CONFIRMED", "RSI_VWAP_HOLD_CONFIRMED", "RSI_RESISTANCE_BREAK_PENDING"]
            return "FORMING", [*common, "RSI_VWAP_RECLAIM_CONFIRMED", "RSI_VWAP_HOLD_PENDING"]

        if memory.state == "READY":
            return "READY", [*common, "RSI_VWAP_RECLAIM_CONFIRMED", "RSI_VWAP_HOLD_CONFIRMED", "RSI_RESISTANCE_BREAK_CONFIRMED"]
        if latest.end > memory.hold_at and memory.resistance_level is not None and latest.close > memory.resistance_level + breakout_buffer(memory.resistance_level, parameters):
            return "READY", [*common, "RSI_VWAP_RECLAIM_CONFIRMED", "RSI_VWAP_HOLD_CONFIRMED", "RSI_RESISTANCE_BREAK_CONFIRMED"]
        return "FORMING", [*common, "RSI_VWAP_RECLAIM_CONFIRMED", "RSI_VWAP_HOLD_CONFIRMED", "RSI_RESISTANCE_BREAK_PENDING"]

    def _find_pair(
        self,
        memory: StrategyMemory,
        bars: list[CandleRecord],
        context: StrategyContext,
        parameters: StrategyParameters,
        timestamp: datetime,
    ) -> tuple[_DivergencePair | None, str | None]:
        rsi_values = context.rsi_by_bar or {}
        pivots = [
            value
            for value in confirmed_pivot_lows(
                bars,
                rsi_values,
                left=parameters.rsi_pivot_left_bars,
                right=parameters.rsi_pivot_right_bars,
            )
            if value.confirmation_timestamp <= timestamp and value.rsi is not None
        ]
        if len(pivots) < 2:
            return None, None
        retired = memory.retired_formation_keys or set()
        for first, second in zip(pivots, pivots[1:]):
            first_index = bars.index(first.pivot_bar)
            second_index = bars.index(second.pivot_bar)
            spacing = second_index - first_index
            if spacing < parameters.rsi_pivot_min_spacing_bars or spacing > parameters.rsi_pivot_max_spacing_bars:
                continue
            if first.pivot_bar.low - second.pivot_bar.low <= min_tick(second.pivot_bar.low):
                continue
            if (second.rsi or 0) - (first.rsi or 0) < parameters.rsi_divergence_min_points:
                continue
            first_window = bars[max(0, first_index - 2) : first_index + 1]
            second_window = bars[max(0, second_index - 2) : second_index + 1]
            ratio = volume_contraction_ratio(second_window, first_window)
            key = f"{first.pivot_bar.end.isoformat()}:{second.pivot_bar.end.isoformat()}"
            if ratio is None:
                return None, "RSI_DIVERGENCE_VOLUME_UNAVAILABLE"
            if ratio > parameters.rsi_divergence_volume_contraction_max_ratio:
                continue
            if key in retired:
                continue
            return _DivergencePair(first, second, ratio, key), None
        return None, None

    @staticmethod
    def _retire(memory: StrategyMemory) -> None:
        if memory.retired_formation_keys is None:
            memory.retired_formation_keys = set()
        if memory.formation_key is not None:
            memory.retired_formation_keys.add(memory.formation_key)
