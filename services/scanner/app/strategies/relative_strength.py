from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

from ..models import ContextScoreComponent, ContextSignalName, ContextStatus, FeatureSnapshot, StrategyParameters
from .base import BenchmarkObservation, StrategyContext


class ContextSignalModule(Protocol):
    key: ContextSignalName
    version: str
    name: str
    description: str

    def evaluate(self, snapshot: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters) -> tuple[ContextStatus, int, float | None, BenchmarkObservation | None, list[str], list[ContextScoreComponent], list[str]]: ...


@dataclass(frozen=True)
class RelativeStrengthSignal:
    key: ContextSignalName
    name: str
    description: str
    benchmark_attribute: str
    unavailable_reason: str
    strong_reason: str
    weak_reason: str
    version: str = "1.0.0"

    def evaluate(self, snapshot: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters) -> tuple[ContextStatus, int, float | None, BenchmarkObservation | None, list[str], list[ContextScoreComponent], list[str]]:
        benchmark: BenchmarkObservation | None = getattr(context, self.benchmark_attribute)
        if not snapshot.actionable or snapshot.data_status != "REALTIME":
            candidate_flag = "CANDIDATE_HALTED" if snapshot.data_status == "HALTED" else "CANDIDATE_STALE"
            flags = [candidate_flag]
            return "UNAVAILABLE", 50, None, benchmark, [f"{self.key}_CANDIDATE_UNAVAILABLE"], self._components(snapshot, benchmark, None, parameters, flags), flags
        if benchmark is None:
            flags = ["BENCHMARK_UNAVAILABLE"]
            return "UNAVAILABLE", 50, None, None, [self.unavailable_reason], self._components(snapshot, None, None, parameters, flags), flags
        if benchmark.change_from_open_pct is None or benchmark.timestamp is None:
            flags = ["BENCHMARK_SESSION_RETURN_UNAVAILABLE"]
            return "UNAVAILABLE", 50, None, benchmark, [self.unavailable_reason, benchmark.reason or "BENCHMARK_DATA_UNAVAILABLE"], self._components(snapshot, benchmark, None, parameters, flags), flags
        if not benchmark.actionable or benchmark.data_status != "REALTIME" or abs(snapshot.timestamp - benchmark.timestamp) > timedelta(seconds=context.benchmark_max_staleness_seconds):
            flags = ["BENCHMARK_STALE"]
            return "STALE", 50, None, benchmark, [f"{self.key}_BENCHMARK_STALE"], self._components(snapshot, benchmark, None, parameters, flags), flags
        observed = snapshot.change_from_open_pct - benchmark.change_from_open_pct
        threshold = max(parameters.relative_strength_min_pct, .01)
        score = max(0, min(100, round(50 + observed / threshold * 25)))
        flags = [] if snapshot.rolling_return_5m_pct is not None and benchmark.rolling_return_5m_pct is not None else ["SHORT_ROLLING_RETURN_UNAVAILABLE"]
        components = self._components(snapshot, benchmark, observed, parameters, flags, score)
        if observed >= threshold:
            return "STRONG", score, observed, benchmark, [self.strong_reason], components, flags
        if observed <= -threshold:
            return "WEAK", score, observed, benchmark, [self.weak_reason], components, flags
        return "NEUTRAL", score, observed, benchmark, [f"{self.key}_NEUTRAL"], components, flags

    @staticmethod
    def _components(snapshot: FeatureSnapshot, benchmark: BenchmarkObservation | None, session_observed: float | None,
                    parameters: StrategyParameters, evaluation_flags: list[str], session_score: int = 50) -> list[ContextScoreComponent]:
        session_flags = evaluation_flags if session_observed is None else []
        rolling_candidate = snapshot.rolling_return_5m_pct
        rolling_benchmark = benchmark.rolling_return_5m_pct if benchmark else None
        rolling_available = not evaluation_flags or evaluation_flags == ["SHORT_ROLLING_RETURN_UNAVAILABLE"]
        rolling_available = rolling_available and rolling_candidate is not None and rolling_benchmark is not None
        rolling_observed = rolling_candidate - rolling_benchmark if rolling_available and rolling_candidate is not None and rolling_benchmark is not None else None
        threshold = max(parameters.relative_strength_min_pct, .01)
        rolling_score = 50 if rolling_observed is None else max(0, min(100, round(50 + rolling_observed / threshold * 25)))
        rolling_flags = [] if rolling_available else (
            evaluation_flags if evaluation_flags and evaluation_flags != ["SHORT_ROLLING_RETURN_UNAVAILABLE"] else ["SHORT_ROLLING_RETURN_UNAVAILABLE"]
        )
        return [
            ContextScoreComponent(
                key="SESSION_RELATIVE_STRENGTH", horizon="SESSION_FROM_OPEN",
                candidate_value=snapshot.change_from_open_pct,
                benchmark_value=benchmark.change_from_open_pct if benchmark else None,
                observed_difference=session_observed, score=session_score, available=session_observed is not None,
                missing_data_flags=session_flags,
            ),
            ContextScoreComponent(
                key="ROLLING_RELATIVE_STRENGTH", horizon="ROLLING_5_MINUTES",
                candidate_value=rolling_candidate, benchmark_value=rolling_benchmark,
                observed_difference=rolling_observed, score=rolling_score, available=rolling_available,
                missing_data_flags=rolling_flags,
            ),
        ]


SectorRelativeStrengthSignal = RelativeStrengthSignal(
    key="SECTOR_RELATIVE_STRENGTH",
    name="Sector-Relative Strength",
    description="Outperformance versus a configured, stable sector benchmark.",
    benchmark_attribute="sector_benchmark",
    unavailable_reason="SECTOR_BENCHMARK_UNAVAILABLE",
    strong_reason="SECTOR_RELATIVE_STRENGTH_STRONG",
    weak_reason="SECTOR_RELATIVE_STRENGTH_WEAK",
)

MarketRelativeStrengthSignal = RelativeStrengthSignal(
    key="MARKET_RELATIVE_STRENGTH",
    name="Market-Relative Strength",
    description="Outperformance versus a configured, stable broad-market benchmark.",
    benchmark_attribute="market_benchmark",
    unavailable_reason="MARKET_BENCHMARK_UNAVAILABLE",
    strong_reason="MARKET_RELATIVE_STRENGTH_STRONG",
    weak_reason="MARKET_RELATIVE_STRENGTH_WEAK",
)
