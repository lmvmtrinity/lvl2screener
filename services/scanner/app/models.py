from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from .scoring import SCORE_VERSION


SetupStrategyName = Literal[
    "ORB_RETEST",
    "VWAP_HOLD",
    "VWAP_RECLAIM",
    "RSI_VWAP_RECLAIM",
    "HIGH_OF_DAY_BREAKOUT",
    "BULL_FLAG",
    "PRIOR_DAY_HIGH_BREAKOUT",
]
MarketId = Literal["CA_TSX", "US_EQUITIES"]
ContextSignalName = Literal[
    "SECTOR_RELATIVE_STRENGTH",
    "MARKET_RELATIVE_STRENGTH",
]
StrategyName = SetupStrategyName | ContextSignalName
AnalysisKind = Literal["SETUP", "CONTEXT"]


class CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class ServiceHealth(BaseModel):
    service: Literal["scanner"]
    status: Literal["ok", "degraded"]
    version: str
    timestamp: AwareDatetime


class ScannerChecks(CamelModel):
    config: Literal["ok"]
    feature_engine: Literal["ok"] = Field(alias="featureEngine")


class ScannerReadiness(ServiceHealth):
    checks: ScannerChecks


class InstrumentRef(CamelModel):
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    sector: str | None = None
    role: Literal["CANDIDATE", "BENCHMARK"] = "CANDIDATE"
    benchmark_kind: Literal["MARKET", "SECTOR"] | None = Field(default=None, alias="benchmarkKind")
    benchmark_sector: str | None = Field(default=None, alias="benchmarkSector")


class BenchmarkRef(CamelModel):
    kind: Literal["MARKET", "SECTOR"]
    symbol: str
    sector: str | None = None


class TimeWindow(CamelModel):
    start: str = Field(pattern=r"^\d{2}:\d{2}$")
    end: str = Field(pattern=r"^\d{2}:\d{2}$")


class EntryWindow(CamelModel):
    preferred_start: str = Field(default="10:00", alias="preferredStart", pattern=r"^\d{2}:\d{2}$")
    preferred_end: str = Field(default="11:30", alias="preferredEnd", pattern=r"^\d{2}:\d{2}$")
    hard_end: str = Field(default="16:00", alias="hardEnd", pattern=r"^\d{2}:\d{2}$")


class StrategyParameters(CamelModel):
    rvol_at_time_min: float = Field(default=1.5, ge=0, le=20, alias="rvolAtTimeMin")
    spread_hard_max_pct: float = Field(default=0.25, gt=0, le=5, alias="spreadHardMaxPct")
    atr_pct_min: float = Field(default=0, ge=0, le=20, alias="atrPctMin")
    breakout_volume_ratio_min: float = Field(default=1.5, gt=0, le=20, alias="breakoutVolumeRatioMin")
    retest_tolerance_pct: float = Field(default=0.15, ge=0, le=5, alias="retestTolerancePct")
    score_cutoff: int = Field(default=0, ge=0, le=100, alias="scoreCutoff")
    breakout_buffer_pct: float = Field(default=0.05, ge=0, le=5, alias="breakoutBufferPct")
    relative_strength_min_pct: float = Field(default=0.5, ge=0, le=20, alias="relativeStrengthMinPct")
    flagpole_min_atr: float = Field(default=0.5, gt=0, le=10, alias="flagpoleMinAtr")
    flag_retracement_max_pct: float = Field(default=50, gt=0, le=100, alias="flagRetracementMaxPct")
    setup_timeout_minutes: int = Field(default=20, ge=5, le=120, alias="setupTimeoutMinutes")
    #: Minimum completed bars immediately preceding a breakout that must form a
    #: tight base for the breakout to count (HIGH_OF_DAY_BREAKOUT).
    consolidation_bars_min: int = Field(default=3, ge=1, le=20, alias="consolidationBarsMin")
    #: Max high/low range of that base, as a percent of the breakout level.
    consolidation_range_max_pct: float = Field(default=0.75, gt=0, le=10, alias="consolidationRangeMaxPct")
    #: Bull flag consolidation length bounds, in completed bars.
    flag_duration_bars_min: int = Field(default=1, ge=1, le=10, alias="flagDurationBarsMin")
    flag_duration_bars_max: int = Field(default=2, ge=1, le=10, alias="flagDurationBarsMax")
    #: Minimum flagpole steepness (ATR per impulse bar), rejecting a tall but slow drift.
    flagpole_min_slope_atr_per_bar: float = Field(default=0, ge=0, le=5, alias="flagpoleMinSlopeAtrPerBar")
    #: Flag volume must fall to at most this percent of the impulse's average volume.
    volume_contraction_max_pct: float = Field(default=100, gt=0, le=100, alias="volumeContractionMaxPct")
    #: Opt-in retest ablations. Zero preserves the historical strategy behavior.
    retest_volume_contraction_enabled: int = Field(default=0, ge=0, le=1, alias="retestVolumeContractionEnabled")
    retest_high_break_enabled: int = Field(default=0, ge=0, le=1, alias="retestHighBreakEnabled")
    retest_rejection_enabled: int = Field(default=0, ge=0, le=1, alias="retestRejectionEnabled")
    retest_volume_contraction_max_ratio: float = Field(default=0.8, gt=0, le=1, alias="retestVolumeContractionMaxRatio")
    rejection_lower_wick_body_min: float = Field(default=2, gt=0, le=20, alias="rejectionLowerWickBodyMin")
    rejection_upper_wick_range_max_pct: float = Field(default=20, ge=0, le=100, alias="rejectionUpperWickRangeMaxPct")
    rejection_close_location_min_pct: float = Field(default=65, ge=0, le=100, alias="rejectionCloseLocationMinPct")
    #: RSI research seeds. The first profile uses Wilder RSI(14) and 2/2 pivots.
    # First experiment is deliberately constrained to the centrally cached
    # Wilder RSI(14) series; changing period requires a new cache key/version.
    rsi_period: int = Field(default=14, ge=14, le=14, alias="rsiPeriod")
    rsi_pivot_left_bars: int = Field(default=2, ge=1, le=10, alias="rsiPivotLeftBars")
    rsi_pivot_right_bars: int = Field(default=2, ge=1, le=10, alias="rsiPivotRightBars")
    rsi_pivot_min_spacing_bars: int = Field(default=3, ge=1, le=50, alias="rsiPivotMinSpacingBars")
    rsi_pivot_max_spacing_bars: int = Field(default=12, ge=1, le=100, alias="rsiPivotMaxSpacingBars")
    rsi_divergence_min_points: float = Field(default=3, ge=0, le=100, alias="rsiDivergenceMinPoints")
    rsi_divergence_volume_contraction_max_ratio: float = Field(default=0.8, gt=0, le=1, alias="rsiDivergenceVolumeContractionMaxRatio")
    rsi_setup_timeout_minutes: int = Field(default=30, ge=5, le=120, alias="rsiSetupTimeoutMinutes")
    #: Optional explanatory/experimental prior-day trend filter; zero is legacy behavior.
    daily_ema_filter_enabled: int = Field(default=0, ge=0, le=1, alias="dailyEmaFilterEnabled")
    #: Stop selection policy: HYBRID (max of pattern and support), PATTERN_INVALIDATION, or NEAREST_SUPPORT.
    stop_policy: Literal["HYBRID", "PATTERN_INVALIDATION", "NEAREST_SUPPORT"] = Field(
        default="HYBRID", alias="stopPolicy"
    )


class ScannerProfileConfig(CamelModel):
    profile_id: UUID = Field(alias="profileId")
    profile_name: str = Field(alias="profileName", min_length=1)
    market_id: MarketId = Field(default="CA_TSX", alias="marketId")
    strategy: StrategyName
    analysis_kind: AnalysisKind = Field(default="SETUP", alias="analysisKind")
    strategy_version: Literal["1.0.0"] = Field(default="1.0.0", alias="strategyVersion")
    config_version: str = Field(alias="configVersion", min_length=1)
    parameters: StrategyParameters = Field(default_factory=StrategyParameters)
    enabled: bool = True
    display_order: int = Field(default=0, ge=0, alias="displayOrder")
    #: Per-strategy override of the session-wide entry window. `None` keeps
    #: using `SessionStart.entries` for this profile.
    entry_window: EntryWindow | None = Field(default=None, alias="entryWindow")


class ScannerProfileBatch(CamelModel):
    profiles: list[ScannerProfileConfig]


class SessionStart(CamelModel):
    market_id: MarketId = Field(default="CA_TSX", alias="marketId")
    market: str
    timezone: Literal["America/Toronto", "America/New_York"]
    start_time: AwareDatetime = Field(alias="startTime")
    end_time: AwareDatetime = Field(alias="endTime")
    instruments: list[InstrumentRef]
    benchmarks: list[BenchmarkRef] = Field(default_factory=list)
    benchmark_max_staleness_seconds: int = Field(default=30, ge=1, le=300, alias="benchmarkMaxStalenessSeconds")
    opening_range: TimeWindow = Field(
        default_factory=lambda: TimeWindow(start="09:30", end="09:45"), alias="openingRange"
    )
    scanning: TimeWindow = Field(default_factory=lambda: TimeWindow(start="09:45", end="16:00"))
    entries: EntryWindow = Field(default_factory=EntryWindow)
    profiles: list[ScannerProfileConfig] = Field(default_factory=list)


class QuoteRecord(CamelModel):
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    timestamp: AwareDatetime
    bid: float
    ask: float
    bid_size: int = Field(alias="bidSize", ge=0)
    ask_size: int = Field(alias="askSize", ge=0)
    spread: float = Field(ge=0)
    last: float
    day_open: float = Field(alias="dayOpen")
    day_high: float = Field(alias="dayHigh")
    day_low: float = Field(alias="dayLow")
    volume: int
    data_status: Literal["REALTIME", "DELAYED", "HALTED"] = Field(alias="dataStatus")
    actionable: bool
    delay_seconds: int | None = Field(default=None, alias="delaySeconds", ge=0)


class QuoteBatch(CamelModel):
    market_id: MarketId = Field(default="CA_TSX", alias="marketId")
    quotes: list[QuoteRecord]


class CandleRecord(CamelModel):
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    timeframe: Literal["OneMinute", "FiveMinutes", "OneDay"]
    start: AwareDatetime
    end: AwareDatetime
    open: float
    high: float
    low: float
    close: float
    volume: int
    is_complete: bool = Field(alias="isComplete")


class CandleBatch(CamelModel):
    market_id: MarketId = Field(default="CA_TSX", alias="marketId")
    candles: list[CandleRecord]


class InstrumentWarmup(CamelModel):
    """Add one candidate to a live session without resetting other strategy state."""

    market_id: MarketId = Field(default="CA_TSX", alias="marketId")
    instrument: InstrumentRef
    candles: list[CandleRecord] = Field(default_factory=list)
    as_of: AwareDatetime = Field(alias="asOf")


class InstrumentWarmupReadiness(CamelModel):
    """Evidence that an incrementally admitted candidate can enter strategy evaluation."""

    instrument_id: UUID = Field(alias="instrumentId")
    ready: bool
    daily_history_count: int = Field(alias="dailyHistoryCount")
    historical_intraday_session_count: int = Field(alias="historicalIntradaySessionCount")
    current_session_one_minute_count: int = Field(alias="currentSessionOneMinuteCount")
    opening_range_complete: bool = Field(alias="openingRangeComplete")
    benchmark_ready: bool = Field(alias="benchmarkReady")
    reasons: list[str] = Field(default_factory=list)


class FeatureLevelProvenance(CamelModel):
    level_id: str = Field(alias="levelId")
    origin_at: AwareDatetime = Field(alias="originAt")
    available_at: AwareDatetime = Field(alias="availableAt")

    @model_validator(mode="after")
    def validate_times(self) -> "FeatureLevelProvenance":
        if self.available_at < self.origin_at:
            raise ValueError("level availability precedes origin")
        return self


class FeatureLevel(CamelModel):
    price: float
    type: str
    strength: float
    tests: int
    age_bars: int = Field(alias="ageBars")
    provenance: FeatureLevelProvenance | None = None


class LevelConfluence(CamelModel):
    """Distinct level types (PDH/ORH/HOD/VWAP/confirmed pivot) clustered near one anchor price.

    `level_types` is deduplicated by type, so two swing highs a tick apart near the same
    anchor still count once, not twice.
    """

    price: float
    level_types: list[str] = Field(alias="levelTypes")
    count: int


class OpeningRangeFeature(CamelModel):
    high: float
    low: float
    mid: float
    width: float
    width_pct: float = Field(alias="widthPct")
    width_atr: float | None = Field(alias="widthAtr")
    volume: int
    complete: bool


class DailyEMAContextFeature(CamelModel):
    status: Literal["BULLISH", "NEUTRAL", "BEARISH", "UNAVAILABLE"]
    ema13: float | None = Field(alias="ema13")
    ema21: float | None = Field(alias="ema21")
    slope13: float | None = Field(alias="slope13")
    slope21: float | None = Field(alias="slope21")
    source_timestamp: AwareDatetime | None = Field(default=None, alias="sourceTimestamp")
    reason: str | None = None


class FeatureSnapshot(CamelModel):
    market_id: MarketId = Field(alias="marketId")
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    timestamp: AwareDatetime
    timeframe: Literal["OneMinute"] = "OneMinute"
    feature_version: str = Field(alias="featureVersion")
    config_version: str = Field(alias="configVersion")
    data_status: Literal["REALTIME", "DELAYED", "HALTED"] = Field(alias="dataStatus")
    actionable: bool
    price: float
    bid: float
    ask: float
    mid: float
    spread_absolute: float = Field(alias="spreadAbsolute")
    spread_pct: float = Field(alias="spreadPct")
    change_from_open_pct: float = Field(alias="changeFromOpenPct")
    rolling_return_5m_pct: float | None = Field(default=None, alias="rollingReturn5mPct")
    vwap: float | None
    completed_bar_vwap: float | None = Field(default=None, alias="completedBarVwap")
    completed_bar_vwap_timestamp: AwareDatetime | None = Field(default=None, alias="completedBarVwapTimestamp")
    distance_from_vwap_pct: float | None = Field(alias="distanceFromVwapPct")
    close_above_vwap: bool | None = Field(alias="closeAboveVwap")
    last_3_closes_above_vwap: int = Field(alias="last3ClosesAboveVwap")
    vwap_slope_pct: float | None = Field(alias="vwapSlopePct")
    touch_vwap: bool = Field(alias="touchVwap")
    vwap_reclaim: bool = Field(alias="vwapReclaim")
    vwap_rejection: bool = Field(alias="vwapRejection")
    rsi_14: float | None = Field(default=None, alias="rsi14")
    rsi_timestamp: AwareDatetime | None = Field(default=None, alias="rsiTimestamp")
    daily_ema_context: DailyEMAContextFeature | None = Field(default=None, alias="dailyEmaContext")
    atr_14: float | None = Field(alias="atr14")
    atr_pct: float | None = Field(alias="atrPct")
    rvol_at_time: float | None = Field(alias="rvolAtTime")
    current_cumulative_volume: int = Field(alias="currentCumulativeVolume")
    historical_mean_cumulative_volume: float | None = Field(alias="historicalMeanCumulativeVolume")
    opening_range: OpeningRangeFeature | None = Field(alias="openingRange")
    swing_highs: list[FeatureLevel] = Field(alias="swingHighs")
    swing_lows: list[FeatureLevel] = Field(alias="swingLows")
    nearest_support: FeatureLevel | None = Field(alias="nearestSupport")
    nearest_resistance: FeatureLevel | None = Field(alias="nearestResistance")
    #: Distinct level types (PDH/ORH/HOD/VWAP/confirmed pivot) clustered near
    #: `nearest_support`/`nearest_resistance`, deduplicated by type.
    support_confluence: LevelConfluence | None = Field(default=None, alias="supportConfluence")
    resistance_confluence: LevelConfluence | None = Field(default=None, alias="resistanceConfluence")
    distance_from_vwap_atr: float | None = Field(alias="distanceFromVwapAtr")
    distance_from_orh_atr: float | None = Field(alias="distanceFromOrhAtr")
    change_from_open_atr: float | None = Field(alias="changeFromOpenAtr")
    consecutive_green_candles: int = Field(alias="consecutiveGreenCandles")
    recent_move_velocity_atr: float | None = Field(alias="recentMoveVelocityAtr")
    warming_up: list[str] = Field(alias="warmingUp")


class FeatureSnapshotBatch(CamelModel):
    snapshots: list[FeatureSnapshot]


StrategyState = Literal["INACTIVE", "WATCH", "FORMING", "READY", "INVALIDATED", "EXPIRED", "HALTED", "DATA_STALE"]


ScoreGroupName = Literal["pattern", "confirmation", "structure", "liquidity", "timing", "penalties"]


class SetupScoreComponents(CamelModel):
    """Phase 4 component budget. The six values always sum to `setupScore`."""

    pattern: int = 0
    confirmation: int = 0
    structure: int = 0
    liquidity: int = 0
    timing: int = 0
    penalties: int = 0


class SetupScoreContribution(CamelModel):
    key: str
    group: ScoreGroupName
    label: str
    points: int
    maximum: int
    value: float | None = None
    detail: str


class FormationPivotEvidence(CamelModel):
    """One confirmed price pivot and the RSI sampled at that exact bar end."""

    timestamp: AwareDatetime
    price: float
    rsi: float


class RetestFormationEvidence(CamelModel):
    """Immutable retest inputs selected while a setup formation is built."""

    impulse_start_at: AwareDatetime | None = Field(default=None, alias="impulseStartAt")
    impulse_end_at: AwareDatetime | None = Field(default=None, alias="impulseEndAt")
    impulse_mean_volume: float | None = Field(default=None, alias="impulseMeanVolume")
    retest_bar_end: AwareDatetime | None = Field(default=None, alias="retestBarEnd")
    retest_bar_high: float | None = Field(default=None, alias="retestBarHigh")
    retest_bar_low: float | None = Field(default=None, alias="retestBarLow")
    pullback_volume_sum: float | None = Field(default=None, alias="pullbackVolumeSum")
    pullback_volume_count: int | None = Field(default=None, alias="pullbackVolumeCount")
    volume_contraction_ratio: float | None = Field(default=None, alias="volumeContractionRatio")
    volume_unavailable: bool = Field(alias="volumeUnavailable")
    support_rejection_confirmed: bool = Field(alias="supportRejectionConfirmed")


class RsiVwapReclaimFormationEvidence(CamelModel):
    """Bound inputs for the ordered RSI divergence and VWAP reclaim lifecycle."""

    indicator_version: str = Field(alias="indicatorVersion")
    first_pivot: FormationPivotEvidence = Field(alias="firstPivot")
    second_pivot: FormationPivotEvidence = Field(alias="secondPivot")
    divergence_confirmed_at: AwareDatetime = Field(alias="divergenceConfirmedAt")
    divergence_volume_contraction_ratio: float | None = Field(
        default=None, alias="divergenceVolumeContractionRatio"
    )
    reclaim_at: AwareDatetime | None = Field(default=None, alias="reclaimAt")
    hold_at: AwareDatetime | None = Field(default=None, alias="holdAt")
    frozen_resistance: float | None = Field(default=None, alias="frozenResistance")
    invalidation_level: float | None = Field(default=None, alias="invalidationLevel")


class FormationEvidence(CamelModel):
    """Versioned, formation-bound evidence carried with evaluations and events.

    This is deliberately distinct from a feature snapshot: it records the exact
    pivots, retest bars, and levels selected by the state machine, so later
    scans or an in-memory reset cannot change how a persisted decision is read.
    """

    version: Literal["formation-evidence-v1"] = "formation-evidence-v1"
    strategy: SetupStrategyName
    formation_key: str | None = Field(default=None, alias="formationKey")
    setup_level: float | None = Field(default=None, alias="setupLevel")
    stop_level: float | None = Field(default=None, alias="stopLevel")
    retest: RetestFormationEvidence | None = None
    rsi_vwap_reclaim: RsiVwapReclaimFormationEvidence | None = Field(
        default=None, alias="rsiVwapReclaim"
    )


class StrategyEvaluation(CamelModel):
    kind: Literal["SETUP"] = "SETUP"
    market_id: MarketId = Field(alias="marketId")
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    timestamp: AwareDatetime
    profile_id: UUID = Field(alias="profileId")
    profile_name: str = Field(alias="profileName")
    strategy: SetupStrategyName
    strategy_version: Literal["1.0.0"] = Field(alias="strategyVersion")
    config_version: str = Field(alias="configVersion")
    state: StrategyState
    score: int = Field(ge=0, le=100)
    setup_score: int = Field(ge=0, le=100, alias="setupScore")
    score_version: str = Field(default=SCORE_VERSION, min_length=1, alias="scoreVersion")
    score_components: SetupScoreComponents = Field(default_factory=SetupScoreComponents, alias="scoreComponents")
    score_explanation: list[SetupScoreContribution] = Field(default_factory=list, alias="scoreExplanation")
    #: Identifies one concrete formation (e.g. one ORH breakout and retest) so
    #: repeated alerts, invalidation, and re-arm all refer to the same lifecycle.
    setup_instance_id: UUID | None = Field(default=None, alias="setupInstanceId")
    reason_codes: list[str] = Field(alias="reasonCodes")
    entry_reference: float | None = Field(alias="entryReference")
    stop_reference: float | None = Field(alias="stopReference")
    target_reference: float | None = Field(alias="targetReference")
    estimated_rr: float | None = Field(alias="estimatedRr")
    entry_window: EntryWindow | None = Field(default=None, alias="entryWindow")
    signal_semantics_version: str = Field(default="setup-semantics-v2", alias="signalSemanticsVersion")
    stop_policy: str = Field(default="HYBRID", alias="stopPolicy")
    pattern_stop_reference: float | None = Field(default=None, alias="patternStopReference")
    stop_selection_reason: str | None = Field(default=None, alias="stopSelectionReason")
    # Optional for backward-compatible reads of results persisted before the
    # formation-evidence boundary was introduced.
    formation_evidence: FormationEvidence | None = Field(default=None, alias="formationEvidence")
    feature_snapshot: FeatureSnapshot = Field(alias="featureSnapshot")


class StrategyStateEvent(StrategyEvaluation):
    event_id: UUID = Field(alias="eventId")
    event_type: Literal["STRATEGY_STATE_CHANGED"] = Field(default="STRATEGY_STATE_CHANGED", alias="eventType")
    previous_state: StrategyState = Field(alias="previousState")


class BacktestParameters(StrategyParameters):
    pass


class BacktestAssumptions(CamelModel):
    starting_capital: float = Field(gt=0, alias="startingCapital")
    position_size: float = Field(gt=0, alias="positionSize")
    slippage_bps: float = Field(ge=0, alias="slippageBps")
    fee_per_trade: float = Field(ge=0, alias="feePerTrade")
    stop_method: Literal["STRUCTURAL", "ATR"] = Field(default="STRUCTURAL", alias="stopMethod")
    atr_stop_multiple: float = Field(default=1, gt=0, le=10, alias="atrStopMultiple")
    reward_risk_ratio: float | None = Field(default=None, gt=0, le=20, alias="rewardRiskRatio")


class BacktestSession(CamelModel):
    session: SessionStart
    candles: list[CandleRecord]
    quotes: list[QuoteRecord]


class BacktestReplayRequest(CamelModel):
    run_id: UUID = Field(alias="runId")
    market_id: MarketId = Field(default="CA_TSX", alias="marketId")
    config_version: str = Field(alias="configVersion")
    strategies: list[SetupStrategyName]
    parameters: BacktestParameters = Field(default_factory=BacktestParameters)
    assumptions: BacktestAssumptions
    sessions: list[BacktestSession]


class BacktestReplayChunkRequest(CamelModel):
    """W8: one Toronto session of a chunked backtest run. `chunk_id` groups the calls that make up
    one run (the worker uses the backtest run's id); the scanner service accumulates `session`s in
    memory under that key and only invokes the replay engine once, on the chunk with
    `is_final=True` -- see `backtest_chunks.ChunkedBacktestAccumulator`."""

    chunk_id: str = Field(alias="chunkId", min_length=1)
    run_id: UUID = Field(alias="runId")
    market_id: MarketId = Field(default="CA_TSX", alias="marketId")
    config_version: str = Field(alias="configVersion")
    strategies: list[SetupStrategyName]
    parameters: BacktestParameters = Field(default_factory=BacktestParameters)
    assumptions: BacktestAssumptions
    session: BacktestSession
    is_final: bool = Field(alias="isFinal")


class BacktestMetrics(CamelModel):
    signals_generated: int = Field(alias="signalsGenerated")
    ready_signals: int = Field(alias="readySignals")
    trades_simulated: int = Field(alias="tradesSimulated")
    wins: int
    losses: int
    win_rate: float = Field(alias="winRate")
    average_win: float = Field(alias="averageWin")
    average_loss: float = Field(alias="averageLoss")
    average_r: float = Field(alias="averageR")
    median_r: float = Field(alias="medianR")
    profit_factor: float | None = Field(alias="profitFactor")
    expectancy: float
    net_pnl: float = Field(alias="netPnl")
    maximum_drawdown: float = Field(alias="maximumDrawdown")
    maximum_drawdown_pct: float = Field(alias="maximumDrawdownPct")
    false_breakout_rate: float = Field(alias="falseBreakoutRate")
    signal_to_trade_conversion: float = Field(alias="signalToTradeConversion")
    average_hold_minutes: float = Field(alias="averageHoldMinutes")


class BacktestSlice(CamelModel):
    dimension: Literal["STRATEGY", "SCORE_BUCKET", "TIME_OF_DAY", "SECTOR", "ATR_REGIME", "RVOL_REGIME"]
    bucket: str
    trades: int
    wins: int
    win_rate: float = Field(alias="winRate")
    average_r: float = Field(alias="averageR")
    expectancy: float
    net_pnl: float = Field(alias="netPnl")


class BacktestTrade(CamelModel):
    id: UUID
    run_id: UUID = Field(alias="runId")
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    strategy: SetupStrategyName
    strategy_version: str = Field(alias="strategyVersion")
    config_version: str = Field(alias="configVersion")
    signal_timestamp: AwareDatetime = Field(alias="signalTimestamp")
    score: int
    entry_time: AwareDatetime = Field(alias="entryTime")
    entry_price: float = Field(alias="entryPrice")
    stop_price: float = Field(alias="stopPrice")
    target_price: float = Field(alias="targetPrice")
    exit_time: AwareDatetime = Field(alias="exitTime")
    exit_price: float = Field(alias="exitPrice")
    shares: int
    exit_reason: Literal["STOP", "TARGET", "SESSION_CLOSE"] = Field(alias="exitReason")
    gross_pnl: float = Field(alias="grossPnl")
    net_pnl: float = Field(alias="netPnl")
    r_multiple: float = Field(alias="rMultiple")
    hold_minutes: float = Field(alias="holdMinutes")
    reason_codes: list[str] = Field(alias="reasonCodes")
    sector: str | None = None
    atr_pct: float | None = Field(default=None, alias="atrPct")
    rvol_at_time: float | None = Field(default=None, alias="rvolAtTime")
    context_score: int = Field(default=50, ge=0, le=100, alias="contextScore")
    contexts: list["ContextEvaluation"] = Field(default_factory=list)
    setup_instance_id: UUID | None = Field(default=None, alias="setupInstanceId")
    # Paper-evidence datasets use this immutable key to carry the qualified
    # train/test membership through the model engine.
    source_key: str | None = Field(default=None, alias="sourceKey")


class BacktestTimelineEvent(CamelModel):
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    strategy: SetupStrategyName
    timestamp: AwareDatetime
    previous_state: StrategyState = Field(alias="previousState")
    state: StrategyState
    score: int
    reason_codes: list[str] = Field(alias="reasonCodes")
    setup_instance_id: UUID | None = Field(default=None, alias="setupInstanceId")


ContextStatus = Literal["UNAVAILABLE", "WEAK", "NEUTRAL", "STRONG", "STALE"]


class ContextScoreComponent(CamelModel):
    """One independently inspectable context horizon.

    Missing or unusable observations stay neutral at 50.  Keeping the raw
    candidate, benchmark, and difference values beside the component score
    makes later ranking research reproducible without reverse engineering a
    categorical status.
    """

    key: Literal["SESSION_RELATIVE_STRENGTH", "ROLLING_RELATIVE_STRENGTH"]
    horizon: Literal["SESSION_FROM_OPEN", "ROLLING_5_MINUTES"]
    candidate_value: float | None = Field(alias="candidateValue")
    benchmark_value: float | None = Field(alias="benchmarkValue")
    observed_difference: float | None = Field(alias="observedDifference")
    score: int = Field(default=50, ge=0, le=100)
    available: bool = False
    missing_data_flags: list[str] = Field(default_factory=list, alias="missingDataFlags")


class ContextEvaluation(CamelModel):
    kind: Literal["CONTEXT"] = "CONTEXT"
    market_id: MarketId = Field(default="CA_TSX", alias="marketId")
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    timestamp: AwareDatetime
    profile_id: UUID = Field(alias="profileId")
    profile_name: str = Field(alias="profileName")
    signal: ContextSignalName
    signal_version: Literal["1.0.0"] = Field(alias="signalVersion")
    config_version: str = Field(alias="configVersion")
    status: ContextStatus
    context_score: int = Field(ge=0, le=100, alias="contextScore")
    context_score_version: str = Field(default="context-score-v2", min_length=1, alias="contextScoreVersion")
    context_score_components: list[ContextScoreComponent] = Field(default_factory=list, alias="contextScoreComponents")
    missing_data_flags: list[str] = Field(default_factory=list, alias="missingDataFlags")
    observed_value: float | None = Field(alias="observedValue")
    benchmark_symbol: str | None = Field(alias="benchmarkSymbol")
    benchmark_value: float | None = Field(alias="benchmarkValue")
    benchmark_timestamp: AwareDatetime | None = Field(alias="benchmarkTimestamp")
    lookback: Literal["SESSION_FROM_OPEN"] = "SESSION_FROM_OPEN"
    reason_codes: list[str] = Field(alias="reasonCodes")
    feature_snapshot: FeatureSnapshot = Field(alias="featureSnapshot")


class BenchmarkReadinessItem(CamelModel):
    kind: Literal["MARKET", "SECTOR"]
    sector: str | None = None
    symbol: str
    status: Literal["READY", "UNAVAILABLE", "STALE"]
    timestamp: AwareDatetime | None = None
    reason: str | None = None


class BenchmarkReadiness(CamelModel):
    market: BenchmarkReadinessItem | None = None
    sectors: list[BenchmarkReadinessItem] = Field(default_factory=list)


class EngineTimings(CamelModel):
    """Phase 0 baseline latency, measured inside one quote-ingest request."""

    feature_ms: float = Field(default=0, ge=0, alias="featureMs")
    evaluation_ms: float = Field(default=0, ge=0, alias="evaluationMs")


class EngineResultBatch(FeatureSnapshotBatch):
    evaluations: list[StrategyEvaluation]
    events: list[StrategyStateEvent]
    contexts: list[ContextEvaluation]
    benchmark_readiness: BenchmarkReadiness = Field(alias="benchmarkReadiness")
    timings: EngineTimings = Field(default_factory=EngineTimings)


class BacktestDataQuality(CamelModel):
    quote_snapshots: int = Field(alias="quoteSnapshots")
    candles: int
    sessions: int
    spread: Literal["CAPTURED", "UNAVAILABLE"]
    warnings: list[str]


class BacktestSignalReplayResult(CamelModel):
    events: list[StrategyStateEvent]
    contexts: list[ContextEvaluation]
    data_quality: BacktestDataQuality = Field(alias="dataQuality")


class BacktestReplayResult(CamelModel):
    metrics: BacktestMetrics
    analyses: list[BacktestSlice]
    trades: list[BacktestTrade]
    timeline: list[BacktestTimelineEvent]
    data_quality: BacktestDataQuality = Field(alias="dataQuality")


class StatisticalTrainingRequest(CamelModel):
    market_id: Literal["CA_TSX", "US_EQUITIES"] = Field(default="CA_TSX", alias="marketId")
    strategy: SetupStrategyName
    trades: list[BacktestTrade]
    train_pct: int = Field(default=80, ge=60, le=90, alias="trainPct")
    minimum_samples: int = Field(default=200, ge=20, le=100_000, alias="minimumSamples")
    l2_penalty: float = Field(default=0.1, ge=0, le=100, alias="l2Penalty")
    training_source_keys: list[str] | None = Field(default=None, alias="trainingSourceKeys")
    testing_source_keys: list[str] | None = Field(default=None, alias="testingSourceKeys")


class StatisticalDatasetMetrics(CamelModel):
    samples: int
    positives: int
    negatives: int
    base_rate: float = Field(alias="baseRate")
    brier_score: float = Field(alias="brierScore")
    baseline_brier_score: float = Field(alias="baselineBrierScore")
    log_loss: float = Field(alias="logLoss")
    roc_auc: float | None = Field(alias="rocAuc")


class StatisticalCalibrationBin(CamelModel):
    lower: float
    upper: float
    samples: int
    predicted_rate: float = Field(alias="predictedRate")
    observed_rate: float = Field(alias="observedRate")


class StatisticalModelArtifact(CamelModel):
    artifact_version: Literal["1.0.0"] = Field(default="1.0.0", alias="artifactVersion")
    model_type: Literal["LOGISTIC_SETUP_QUALITY"] = Field(default="LOGISTIC_SETUP_QUALITY", alias="modelType")
    feature_names: list[str] = Field(alias="featureNames")
    intercept: float
    coefficients: list[float]
    means: list[float]
    scales: list[float]
    medians: list[float]
    atr_median: float = Field(alias="atrMedian")
    rvol_median: float = Field(alias="rvolMedian")


class StatisticalTrainingResult(CamelModel):
    status: Literal["COMPLETED", "INSUFFICIENT_DATA"]
    artifact: StatisticalModelArtifact | None
    train: StatisticalDatasetMetrics | None
    test: StatisticalDatasetMetrics | None
    calibration: list[StatisticalCalibrationBin]
    eligible_for_activation: bool = Field(alias="eligibleForActivation")
    warnings: list[str]
    training_start: AwareDatetime | None = Field(alias="trainingStart")
    training_end: AwareDatetime | None = Field(alias="trainingEnd")
    test_start: AwareDatetime | None = Field(alias="testStart")
    test_end: AwareDatetime | None = Field(alias="testEnd")


class StatisticalPredictionInput(CamelModel):
    market_id: Literal["CA_TSX", "US_EQUITIES"] = Field(default="CA_TSX", alias="marketId")
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    timestamp: AwareDatetime
    profile_id: UUID = Field(alias="profileId")
    profile_name: str = Field(alias="profileName")
    strategy: SetupStrategyName
    deterministic_score: int = Field(ge=0, le=100, alias="deterministicScore")
    atr_pct: float | None = Field(default=None, alias="atrPct")
    rvol_at_time: float | None = Field(default=None, alias="rvolAtTime")


class StatisticalPredictionRequest(CamelModel):
    artifact: StatisticalModelArtifact
    inputs: list[StatisticalPredictionInput]


class StatisticalRegime(CamelModel):
    atr: Literal["LOW", "HIGH", "UNKNOWN"]
    rvol: Literal["LOW", "HIGH", "UNKNOWN"]
    combined: str


class StatisticalPrediction(CamelModel):
    market_id: Literal["CA_TSX", "US_EQUITIES"] = Field(alias="marketId")
    instrument_id: UUID = Field(alias="instrumentId")
    symbol: str
    timestamp: AwareDatetime
    profile_id: UUID = Field(alias="profileId")
    profile_name: str = Field(alias="profileName")
    strategy: SetupStrategyName
    deterministic_score: int = Field(alias="deterministicScore")
    setup_probability: float = Field(alias="setupProbability")
    false_breakout_probability: float = Field(alias="falseBreakoutProbability")
    ranking_score: int = Field(alias="rankingScore")
    regime: StatisticalRegime
    contributions: dict[str, float]
    warnings: list[str]


class StatisticalPredictionBatch(CamelModel):
    predictions: list[StatisticalPrediction]
