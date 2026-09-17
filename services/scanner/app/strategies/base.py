from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import NAMESPACE_URL, UUID, uuid5

from ..feature_indicators import WILDER_RSI_14_VERSION
from ..models import (
    CandleRecord,
    DailyEMAContextFeature,
    FeatureSnapshot,
    FormationEvidence,
    FormationPivotEvidence,
    RetestFormationEvidence,
    RsiVwapReclaimFormationEvidence,
    SetupStrategyName,
    StrategyParameters,
    StrategyState,
)
from ..scoring import ScoreRule


@dataclass
class StrategyMemory:
    state: StrategyState = "INACTIVE"
    breakout_at: datetime | None = None
    pullback_at: datetime | None = None
    last_bar_end: datetime | None = None
    setup_level: float | None = None
    stop_level: float | None = None
    selected_stop_level: float | None = None
    stop_policy: str | None = None
    #: Identity of the concrete formation currently in play. Assigned once a
    #: strategy commits to a formation (e.g. a breakout) and cleared by
    #: `reset_formation` so the next formation gets a fresh identity (re-arm).
    setup_instance_id: UUID | None = None
    # Experimental retest evidence, bound at formation creation and never
    # opportunistically replaced by a later/easier candle.
    impulse_start_at: datetime | None = None
    impulse_end_at: datetime | None = None
    impulse_mean_volume: float | None = None
    retest_volume_ratio: float | None = None
    retest_volume_unavailable: bool = False
    pullback_volume_sum: float = 0.0
    pullback_volume_count: int = 0
    retest_bar_end: datetime | None = None
    retest_bar_high: float | None = None
    retest_bar_low: float | None = None
    support_rejection_confirmed: bool = False
    # RSI/VWAP reclaim formation state. These fields are intentionally typed on
    # the shared memory object so reset and replay identity remain explicit.
    first_pivot_at: datetime | None = None
    first_pivot_price: float | None = None
    first_pivot_rsi: float | None = None
    second_pivot_at: datetime | None = None
    second_pivot_price: float | None = None
    second_pivot_rsi: float | None = None
    divergence_confirmed_at: datetime | None = None
    divergence_volume_ratio: float | None = None
    reclaim_at: datetime | None = None
    hold_at: datetime | None = None
    resistance_level: float | None = None
    invalidation_level: float | None = None
    formation_key: str | None = None
    retired_formation_keys: set[str] | None = None

    def reset_formation(self) -> None:
        """Clear one formation's working state so the strategy can re-arm for a new one."""
        self.breakout_at = None
        self.pullback_at = None
        self.setup_level = None
        self.stop_level = None
        self.selected_stop_level = None
        self.stop_policy = None
        self.setup_instance_id = None
        self.impulse_start_at = None
        self.impulse_end_at = None
        self.impulse_mean_volume = None
        self.retest_volume_ratio = None
        self.retest_volume_unavailable = False
        self.pullback_volume_sum = 0.0
        self.pullback_volume_count = 0
        self.retest_bar_end = None
        self.retest_bar_high = None
        self.retest_bar_low = None
        self.support_rejection_confirmed = False
        self.first_pivot_at = None
        self.first_pivot_price = None
        self.first_pivot_rsi = None
        self.second_pivot_at = None
        self.second_pivot_price = None
        self.second_pivot_rsi = None
        self.divergence_confirmed_at = None
        self.divergence_volume_ratio = None
        self.reclaim_at = None
        self.hold_at = None
        self.resistance_level = None
        self.invalidation_level = None
        self.formation_key = None
        # Retired pair identities survive a formation reset so an expired or
        # invalidated pair cannot re-arm indefinitely on repeated scans.
        if self.retired_formation_keys is None:
            self.retired_formation_keys = set()


def ensure_setup_instance(memory: StrategyMemory, seed: str) -> UUID:
    """Assign a setup-instance id the first time a formation commits; keep it stable after.

    Derived deterministically (uuid5) from `seed` rather than random, so replaying the
    same inputs produces the same instance identity.
    """
    if memory.setup_instance_id is None:
        memory.setup_instance_id = uuid5(NAMESPACE_URL, seed)
    return memory.setup_instance_id


def formation_evidence(memory: StrategyMemory, strategy: SetupStrategyName) -> FormationEvidence | None:
    """Snapshot the state machine's bound formation inputs for durable output.

    A feature snapshot describes the market at one scan. This payload instead
    preserves the specific bars and levels the strategy already selected, and
    is created before terminal state cleanup clears the working memory.
    """
    if memory.setup_instance_id is None:
        return None

    retest = None
    if strategy in ("ORB_RETEST", "VWAP_HOLD"):
        retest = RetestFormationEvidence(
            impulse_start_at=memory.impulse_start_at,
            impulse_end_at=memory.impulse_end_at,
            impulse_mean_volume=memory.impulse_mean_volume,
            retest_bar_end=memory.retest_bar_end,
            retest_bar_high=memory.retest_bar_high,
            retest_bar_low=memory.retest_bar_low,
            pullback_volume_sum=memory.pullback_volume_sum,
            pullback_volume_count=memory.pullback_volume_count,
            volume_contraction_ratio=memory.retest_volume_ratio,
            volume_unavailable=memory.retest_volume_unavailable,
            support_rejection_confirmed=memory.support_rejection_confirmed,
        )

    rsi_vwap_reclaim = None
    if (
        strategy == "RSI_VWAP_RECLAIM"
        and memory.first_pivot_at is not None
        and memory.first_pivot_price is not None
        and memory.first_pivot_rsi is not None
        and memory.second_pivot_at is not None
        and memory.second_pivot_price is not None
        and memory.second_pivot_rsi is not None
        and memory.divergence_confirmed_at is not None
    ):
        rsi_vwap_reclaim = RsiVwapReclaimFormationEvidence(
            indicator_version=WILDER_RSI_14_VERSION,
            first_pivot=FormationPivotEvidence(
                timestamp=memory.first_pivot_at,
                price=memory.first_pivot_price,
                rsi=memory.first_pivot_rsi,
            ),
            second_pivot=FormationPivotEvidence(
                timestamp=memory.second_pivot_at,
                price=memory.second_pivot_price,
                rsi=memory.second_pivot_rsi,
            ),
            divergence_confirmed_at=memory.divergence_confirmed_at,
            divergence_volume_contraction_ratio=memory.divergence_volume_ratio,
            reclaim_at=memory.reclaim_at,
            hold_at=memory.hold_at,
            frozen_resistance=memory.resistance_level,
            invalidation_level=memory.invalidation_level,
        )

    if retest is None and rsi_vwap_reclaim is None:
        return None
    return FormationEvidence(
        strategy=strategy,
        formation_key=memory.formation_key,
        setup_level=memory.setup_level,
        stop_level=memory.stop_level,
        retest=retest,
        rsi_vwap_reclaim=rsi_vwap_reclaim,
    )


@dataclass(frozen=True)
class BenchmarkObservation:
    symbol: str
    change_from_open_pct: float | None
    timestamp: datetime | None
    data_status: str | None
    actionable: bool
    reason: str | None = None
    rolling_return_5m_pct: float | None = None


@dataclass(frozen=True)
class StrategyContext:
    bars: list[CandleRecord]
    #: RSI values sampled at completed 5-minute bar ends. Values include prior
    #: regular-session history for warm-up, while `bars` remains current-session.
    rsi_by_bar: dict[datetime, float] | None = None
    indicator_version: str | None = None
    daily_ema_context: DailyEMAContextFeature | None = None
    prior_day_high: float | None = None
    sector: str | None = None
    sector_benchmark: BenchmarkObservation | None = None
    market_benchmark: BenchmarkObservation | None = None
    benchmark_max_staleness_seconds: int = 30


class StrategyModule(Protocol):
    key: SetupStrategyName
    version: str
    name: str
    description: str
    #: Strategy-owned pattern and confirmation awards. Shared liquidity, structure,
    #: timing, and penalty components stay centralized in `app.scoring`.
    score_rules: tuple[ScoreRule, ...]

    def validate(self, parameters: StrategyParameters) -> StrategyParameters: ...

    def next_state(self, memory: StrategyMemory, snapshot: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters, base_reasons: list[str]) -> tuple[StrategyState, list[str]]: ...

    def trade_references(self, memory: StrategyMemory, snapshot: FeatureSnapshot, context: StrategyContext, state: StrategyState, parameters: StrategyParameters | None = None) -> tuple[float | None, float | None, float | None]: ...


class BaseStrategy:
    key: SetupStrategyName
    version = "1.0.0"
    name: str
    description: str
    use_two_r_target = False
    score_rules: tuple[ScoreRule, ...] = ()

    def validate(self, parameters: StrategyParameters) -> StrategyParameters:
        return StrategyParameters.model_validate(parameters.model_dump())

    def trade_references(
        self,
        memory: StrategyMemory,
        snapshot: FeatureSnapshot,
        context: StrategyContext,
        state: StrategyState,
        parameters: StrategyParameters | None = None,
    ) -> tuple[float | None, float | None, float | None]:
        if state != "READY":
            return None, None, None
        entry = snapshot.price
        pattern_stop = (
            memory.stop_level
            if memory.stop_level is not None and memory.stop_level < entry
            else None
        )
        support_stop = (
            snapshot.nearest_support.price
            if snapshot.nearest_support and snapshot.nearest_support.price < entry
            else None
        )
        policy = (
            parameters.stop_policy
            if parameters and hasattr(parameters, "stop_policy")
            else "HYBRID"
        )
        if policy == "PATTERN_INVALIDATION":
            stop = pattern_stop if pattern_stop is not None else support_stop
        elif policy == "NEAREST_SUPPORT":
            stop = support_stop if support_stop is not None else pattern_stop
        else:  # HYBRID
            candidates = [v for v in (pattern_stop, support_stop) if v is not None]
            stop = max(candidates, default=None)

        memory.selected_stop_level = stop
        memory.stop_policy = policy

        target = (
            snapshot.nearest_resistance.price
            if snapshot.nearest_resistance
            and snapshot.nearest_resistance.price > entry
            else None
        )
        if target is None and self.use_two_r_target and stop is not None:
            target = entry + 2 * (entry - stop)
        return entry, stop, target


def completed_bars(context: StrategyContext, snapshot: FeatureSnapshot) -> list[CandleRecord]:
    return [bar for bar in context.bars if bar.is_complete and bar.end <= snapshot.timestamp]


def volume_confirmed(bars: list[CandleRecord], minimum: float) -> bool:
    if len(bars) < 2:
        return False
    baseline_values = bars[-4:-1]
    baseline = sum(bar.volume for bar in baseline_values) / len(baseline_values)
    return baseline > 0 and bars[-1].volume / baseline >= minimum


def min_tick(price: float) -> float:
    """TSX minimum price increment: $0.005 below $0.50, $0.01 at or above.

    A breakout buffer floored at a flat cent overstates the noise floor for
    sub-$0.50 symbols, where the exchange itself only enforces a half-cent tick.
    """
    return .005 if price < .5 else .01


def breakout_buffer(level: float, parameters: StrategyParameters) -> float:
    return max(min_tick(level), level * parameters.breakout_buffer_pct / 100)
