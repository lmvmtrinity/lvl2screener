from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import fmean
from uuid import UUID
from zoneinfo import ZoneInfo

from .models import (
    CandleRecord,
    BenchmarkReadiness,
    BenchmarkReadinessItem,
    DailyEMAContextFeature,
    FeatureLevel,
    FeatureLevelProvenance,
    FeatureSnapshot,
    InstrumentRef,
    InstrumentWarmupReadiness,
    LevelConfluence,
    OpeningRangeFeature,
    QuoteRecord,
    SessionStart,
)
from .feature_indicators import WILDER_RSI_14_VERSION, daily_ema_context, rsi_by_bar
from .strategy_engine import StrategyEngine
from .strategies.base import BenchmarkObservation, StrategyContext

FEATURE_VERSION = "1.2.0"
CONFIG_VERSION = "phase3-default-v1"


@dataclass(frozen=True)
class _ContextBase:
    """Candle-derived strategy context shared by every quote in one instrument/minute.

    Benchmark observations stay per-call in {@link FeatureEngine.strategy_context} because they
    change with the newest benchmark quote; only the indexed candle, RSI, and daily-EMA inputs
    are cached here."""

    bars: list[CandleRecord]
    rsi_by_bar: dict[datetime, float]
    daily_ema_context: DailyEMAContextFeature
    prior_day_high: float | None


@dataclass(frozen=True)
class _CandleFeatures:
    one_minute: list[CandleRecord]
    five_minute: list[CandleRecord]
    daily: list[CandleRecord]
    vwap: float | None
    atr_14: float | None
    current_volume: int
    historical_mean: float | None
    rvol: float | None
    opening_range: OpeningRangeFeature | None
    swing_highs: list[FeatureLevel]
    swing_lows: list[FeatureLevel]
    last_3_above: int
    vwap_slope: float | None
    touch_vwap: bool
    vwap_reclaim: bool
    vwap_rejection: bool
    rolling_baseline_5m: float | None
    rsi_by_bar: dict[datetime, float]
    rsi_14: float | None
    rsi_timestamp: datetime | None
    daily_ema_context: DailyEMAContextFeature


class FeatureEngine:
    def __init__(self) -> None:
        self._session: SessionStart | None = None
        self._instruments: dict[UUID, InstrumentRef] = {}
        self._candidate_ids: set[UUID] = set()
        self._market_benchmark_id: UUID | None = None
        self._sector_benchmark_ids: dict[str, UUID] = {}
        self._market_benchmark_symbol: str | None = None
        self._sector_benchmark_symbols: dict[str, str] = {}
        self._candles: dict[tuple[UUID, str, datetime], CandleRecord] = {}
        # Chronologically indexed candle series keep replay feature calculation from scanning the
        # entire trailing history for every quote. The legacy mapping remains the source of truth
        # for callers that enumerate candles; these lists are an equivalent execution index.
        self._candle_series: dict[UUID, dict[str, list[CandleRecord]]] = {}
        self._historical_one_minute: dict[UUID, dict[date, list[CandleRecord]]] = {}
        self._quotes: dict[UUID, QuoteRecord] = {}
        self._snapshots: dict[UUID, FeatureSnapshot] = {}
        self._benchmark_unavailable_reasons: dict[UUID, str] = {}
        self._feature_cache: dict[
            UUID,
            tuple[
                tuple[str, str, str, str, int, int, int, int, datetime],
                "_CandleFeatures",
            ],
        ] = {}
        # Per-instrument strategy-context base cache keyed like the feature cache. Replay
        # evaluates the same instrument/minute several times as quote batches arrive; rebuilding
        # the regular-session RSI and daily EMA context for each quote made long sessions
        # quadratic in the session's candle count.
        self._context_cache: dict[
            UUID, tuple[tuple[str, str, int, int, int, datetime], _ContextBase]
        ] = {}
        self.strategies = StrategyEngine()

    def start_session(self, session: SessionStart) -> None:
        if session.end_time <= session.start_time:
            raise ValueError("Session endTime must be after startTime")
        self._session = session
        self._instruments = {instrument.instrument_id: instrument for instrument in session.instruments}
        self._candidate_ids = {instrument.instrument_id for instrument in session.instruments if instrument.role == "CANDIDATE"}
        market = [instrument.instrument_id for instrument in session.instruments if instrument.role == "BENCHMARK" and instrument.benchmark_kind == "MARKET"]
        if len(market) > 1:
            raise ValueError("Only one broad-market benchmark may be configured")
        self._market_benchmark_id = market[0] if market else None
        self._sector_benchmark_ids = {
            instrument.benchmark_sector: instrument.instrument_id
            for instrument in session.instruments
            if instrument.role == "BENCHMARK" and instrument.benchmark_kind == "SECTOR" and instrument.benchmark_sector
        }
        market_config = next((value for value in session.benchmarks if value.kind == "MARKET"), None)
        self._market_benchmark_symbol = market_config.symbol if market_config else None
        self._sector_benchmark_symbols = {value.sector: value.symbol for value in session.benchmarks if value.kind == "SECTOR" and value.sector}
        self._candles.clear()
        self._candle_series.clear()
        self._historical_one_minute.clear()
        self._quotes.clear()
        self._snapshots.clear()
        self._benchmark_unavailable_reasons.clear()
        self._feature_cache.clear()
        self._context_cache.clear()
        self.strategies.reset()
        self.strategies.start_session(session)

    def warm_instrument(self, instrument: InstrumentRef, candles: list[CandleRecord], as_of: datetime | None = None) -> InstrumentWarmupReadiness:
        """Warm a newly admitted candidate while retaining the current session and memories."""
        self._require_session()
        if instrument.instrument_id in self._instruments:
            existing = self._instruments[instrument.instrument_id]
            if existing.symbol != instrument.symbol:
                raise ValueError(f"Instrument identity changed for {instrument.symbol}")
        else:
            self._instruments[instrument.instrument_id] = instrument
        if instrument.role == "CANDIDATE":
            self._candidate_ids.add(instrument.instrument_id)
        self.ingest_candles(candles)
        return self.warmup_readiness(instrument.instrument_id, as_of)

    def warmup_readiness(self, instrument_id: UUID, as_of: datetime | None = None) -> InstrumentWarmupReadiness:
        """Report the independent data gates required before strategy readiness."""
        session = self._require_session()
        instrument = self._instruments.get(instrument_id)
        if instrument is None:
            raise ValueError("Unknown warm-up instrument")
        series = self._candle_series.get(instrument_id, {})
        daily = [
            candle
            for candle in series.get("OneDay", [])
            if candle.is_complete and candle.end <= session.start_time
        ]
        one_minute = [
            candle
            for candle in series.get("OneMinute", [])
            if candle.is_complete and (as_of is None or candle.end <= as_of)
        ]
        current = [
            candle
            for candle in one_minute
            if session.start_time <= candle.start < session.end_time and candle.end <= session.end_time
        ]
        opening_start = max(session.start_time, _session_clock(session, session.opening_range.start))
        opening_end = _session_clock(session, session.opening_range.end)

        def covers_minutes(values: list[CandleRecord], start: datetime, end: datetime) -> bool:
            if end <= start:
                return False
            by_start = {candle.start: candle for candle in values}
            cursor = start
            while cursor < end:
                candle = by_start.get(cursor)
                if candle is None or candle.end != cursor + timedelta(minutes=1) or not candle.is_complete:
                    return False
                cursor += timedelta(minutes=1)
            return cursor == end

        opening_range_complete = covers_minutes(current, opening_start, opening_end)
        current_end = (
            min(as_of, session.end_time).replace(second=0, microsecond=0)
            if as_of is not None
            else max((candle.end for candle in current), default=opening_end)
        )
        required_end = max(opening_end, current_end)
        historical_by_date: dict[date, list[CandleRecord]] = {}
        timezone = ZoneInfo(session.timezone)
        for candle in one_minute:
            if candle.end <= session.start_time:
                historical_by_date.setdefault(candle.start.astimezone(timezone).date(), []).append(candle)
        # Only a continuous matching regular-session prefix establishes an RVOL
        # baseline. One arbitrary print on each of ten dates is insufficient.
        historical_dates = set()
        local_open = session.start_time.astimezone(timezone)
        for trading_date, values in historical_by_date.items():
            start = datetime.combine(trading_date, local_open.timetz())
            if covers_minutes(values, start, start + (required_end - session.start_time)):
                historical_dates.add(trading_date)

        reasons: list[str] = []
        if as_of is None or not session.start_time <= as_of <= session.end_time:
            reasons.append("WARMUP_TIME_UNAVAILABLE")
        if len(daily) < 22:
            reasons.append("DAILY_HISTORY_UNAVAILABLE")
        if len(historical_dates) < 10:
            reasons.append("HISTORICAL_INTRADAY_HISTORY_UNAVAILABLE")
        if not opening_range_complete:
            reasons.append("OPENING_RANGE_UNAVAILABLE")
        if not covers_minutes(current, session.start_time, required_end):
            reasons.append("CURRENT_INTRADAY_HISTORY_UNAVAILABLE")

        benchmark_ready = True
        benchmark = self.benchmark_readiness()
        relevant_benchmarks = []
        if self._market_benchmark_symbol is not None:
            relevant_benchmarks.append(benchmark.market)
        sector_symbol = self._sector_benchmark_symbols.get(instrument.sector or "")
        if self._sector_benchmark_symbols and sector_symbol is None:
            benchmark_ready = False
            reasons.append("SECTOR_BENCHMARK_UNAVAILABLE")
        if sector_symbol is not None:
            relevant_benchmarks.extend(
                item
                for item in benchmark.sectors
                if item.sector == instrument.sector
            )
        for item in relevant_benchmarks:
            if item is None or item.status != "READY":
                benchmark_ready = False
                reasons.append(
                    "BENCHMARK_UNAVAILABLE"
                    if item is None or item.status == "UNAVAILABLE"
                    else "BENCHMARK_STALE"
                )
            elif as_of is not None and (item.timestamp is None or abs(as_of - item.timestamp) > timedelta(seconds=session.benchmark_max_staleness_seconds)):
                benchmark_ready = False
                reasons.append("BENCHMARK_STALE")
        return InstrumentWarmupReadiness(
            instrument_id=instrument_id,
            ready=not reasons,
            daily_history_count=len(daily),
            historical_intraday_session_count=len(historical_dates),
            current_session_one_minute_count=len(current),
            opening_range_complete=opening_range_complete,
            benchmark_ready=benchmark_ready,
            reasons=list(dict.fromkeys(reasons)),
        )

    def five_minute_bars(self, instrument_id: UUID) -> list[CandleRecord]:
        return [
            candle
            for candle in self._candle_series.get(instrument_id, {}).get("FiveMinutes", [])
            if candle.is_complete
        ]

    def strategy_context(self, snapshot: FeatureSnapshot) -> StrategyContext:
        session = self._require_session()
        instrument = self._instruments[snapshot.instrument_id]
        base = self._context_base(snapshot, session)
        market_benchmark = self._benchmark_observation(self._market_benchmark_id, self._market_benchmark_symbol)
        sector = instrument.sector or ""
        sector_benchmark = self._benchmark_observation(self._sector_benchmark_ids.get(sector), self._sector_benchmark_symbols.get(sector))
        return StrategyContext(
            bars=base.bars,
            rsi_by_bar=base.rsi_by_bar,
            indicator_version=WILDER_RSI_14_VERSION,
            daily_ema_context=base.daily_ema_context,
            prior_day_high=base.prior_day_high,
            sector=instrument.sector,
            sector_benchmark=sector_benchmark,
            market_benchmark=market_benchmark,
            benchmark_max_staleness_seconds=session.benchmark_max_staleness_seconds,
        )

    def _context_base(self, snapshot: FeatureSnapshot, session: SessionStart) -> _ContextBase:
        series = self._candle_series.get(snapshot.instrument_id, {})
        one_minute_series = series.get("OneMinute", [])
        five_minute_series = series.get("FiveMinutes", [])
        daily_series = series.get("OneDay", [])
        cache_key = (
            session.market_id,
            str(snapshot.instrument_id),
            len(one_minute_series),
            len(five_minute_series),
            len(daily_series),
            snapshot.timestamp.replace(second=0, microsecond=0),
        )
        cached = self._context_cache.get(snapshot.instrument_id)
        if cached is not None and cached[0] == cache_key:
            return cached[1]
        all_bars = [bar for bar in five_minute_series if bar.is_complete and bar.end <= snapshot.timestamp]
        all_regular_bars = _regular_session_candles(all_bars, session)
        bars = [bar for bar in all_regular_bars if bar.start >= session.start_time]
        daily = [candle for candle in daily_series if candle.is_complete and candle.end <= session.start_time]
        ema = daily_ema_context(daily)
        base = _ContextBase(
            bars=bars,
            rsi_by_bar=rsi_by_bar(all_regular_bars, 14),
            daily_ema_context=DailyEMAContextFeature(
                status=ema.status,
                ema13=ema.ema13,
                ema21=ema.ema21,
                slope13=ema.slope13,
                slope21=ema.slope21,
                source_timestamp=ema.source_timestamp,
                reason=ema.reason,
            ),
            prior_day_high=daily[-1].high if daily else None,
        )
        self._context_cache[snapshot.instrument_id] = (cache_key, base)
        return base

    def is_candidate(self, instrument_id: UUID) -> bool:
        return instrument_id in self._candidate_ids

    def benchmark_readiness(self) -> BenchmarkReadiness:
        market = self._readiness_item(self._market_benchmark_id, self._market_benchmark_symbol, "MARKET", None)
        sectors = [self._readiness_item(self._sector_benchmark_ids.get(sector), symbol, "SECTOR", sector) for sector, symbol in sorted(self._sector_benchmark_symbols.items())]
        return BenchmarkReadiness(market=market, sectors=sectors)

    def _benchmark_observation(self, instrument_id: UUID | None, configured_symbol: str | None) -> BenchmarkObservation | None:
        if configured_symbol is None:
            return None
        snapshot = self._snapshots.get(instrument_id) if instrument_id else None
        if snapshot is None:
            return BenchmarkObservation(symbol=configured_symbol, change_from_open_pct=None, timestamp=None, data_status=None,
                                        actionable=False, reason="BENCHMARK_INSTRUMENT_OR_QUOTE_UNAVAILABLE")
        return BenchmarkObservation(symbol=snapshot.symbol, change_from_open_pct=snapshot.change_from_open_pct,
                                    timestamp=snapshot.timestamp, data_status=snapshot.data_status, actionable=snapshot.actionable,
                                    rolling_return_5m_pct=snapshot.rolling_return_5m_pct)

    def _readiness_item(self, instrument_id: UUID | None, configured_symbol: str | None, kind: str, sector: str | None) -> BenchmarkReadinessItem:
        if configured_symbol is None:
            return BenchmarkReadinessItem(kind=kind, sector=sector, symbol="NOT_CONFIGURED", status="UNAVAILABLE", reason="BENCHMARK_NOT_CONFIGURED")
        if instrument_id is None:
            return BenchmarkReadinessItem(kind=kind, sector=sector, symbol=configured_symbol, status="UNAVAILABLE", reason="BENCHMARK_INSTRUMENT_UNAVAILABLE")
        instrument = self._instruments[instrument_id]
        snapshot = self._snapshots.get(instrument_id)
        if snapshot is None:
            return BenchmarkReadinessItem(
                kind=kind,
                sector=sector,
                symbol=instrument.symbol,
                status="UNAVAILABLE",
                reason=self._benchmark_unavailable_reasons.get(instrument_id, "QUOTE_UNAVAILABLE"),
            )
        if not snapshot.actionable or snapshot.data_status != "REALTIME":
            return BenchmarkReadinessItem(kind=kind, sector=sector, symbol=instrument.symbol, status="STALE", timestamp=snapshot.timestamp, reason="BENCHMARK_DATA_NOT_REALTIME")
        candidate_timestamps = [
            value.timestamp for instrument_id, value in self._snapshots.items()
            if instrument_id in self._candidate_ids
        ]
        aligned_to = max(candidate_timestamps, default=snapshot.timestamp)
        if abs(aligned_to - snapshot.timestamp) > timedelta(seconds=self._require_session().benchmark_max_staleness_seconds):
            return BenchmarkReadinessItem(kind=kind, sector=sector, symbol=instrument.symbol, status="STALE", timestamp=snapshot.timestamp, reason="BENCHMARK_TIMESTAMP_STALE")
        return BenchmarkReadinessItem(kind=kind, sector=sector, symbol=instrument.symbol, status="READY", timestamp=snapshot.timestamp)

    def ingest_candles(self, candles: list[CandleRecord]) -> None:
        self._require_session()
        for candle in candles:
            self._validate_instrument(candle.instrument_id, candle.symbol)
            if candle.end <= candle.start:
                raise ValueError(f"Invalid candle range for {candle.symbol}")
            if candle.volume < 0 or candle.low > candle.high:
                raise ValueError(f"Invalid candle values for {candle.symbol}")
            key = (candle.instrument_id, candle.timeframe, candle.start)
            self._candles[key] = candle
            series = self._candle_series.setdefault(candle.instrument_id, {}).setdefault(candle.timeframe, [])
            index = _bisect_candle_start(series, candle.start)
            if index < len(series) and series[index].start == candle.start:
                series[index] = candle
                self._feature_cache.pop(candle.instrument_id, None)
                self._context_cache.pop(candle.instrument_id, None)
            else:
                series.insert(index, candle)
            if candle.timeframe == "OneMinute" and candle.is_complete and candle.start < self._require_session().start_time:
                historical = self._historical_one_minute.setdefault(candle.instrument_id, {}).setdefault(candle.start.date(), [])
                historical_index = _bisect_candle_start(historical, candle.start)
                if historical_index < len(historical) and historical[historical_index].start == candle.start:
                    historical[historical_index] = candle
                else:
                    historical.insert(historical_index, candle)

        for instrument_id in {candle.instrument_id for candle in candles}:
            quote = self._quotes.get(instrument_id)
            if quote is not None:
                self._snapshots[instrument_id] = self._calculate(quote)

    def ingest_quotes(
        self,
        quotes: list[QuoteRecord],
        *,
        include_benchmark_features: bool = True,
    ) -> list[FeatureSnapshot]:
        self._require_session()
        snapshots: list[FeatureSnapshot] = []
        for quote in quotes:
            self._validate_instrument(quote.instrument_id, quote.symbol)
            if quote.bid <= 0 or quote.ask < quote.bid or quote.last <= 0 or quote.day_open <= 0:
                if self._instruments[quote.instrument_id].role == "BENCHMARK":
                    self._benchmark_unavailable_reasons[quote.instrument_id] = "INVALID_QUOTE_VALUES"
                    self._quotes.pop(quote.instrument_id, None)
                    self._snapshots.pop(quote.instrument_id, None)
                    continue
                raise ValueError(f"Invalid quote values for {quote.symbol}")
            self._benchmark_unavailable_reasons.pop(quote.instrument_id, None)
            self._quotes[quote.instrument_id] = quote
            snapshot = (
                self._calculate(quote)
                if include_benchmark_features or quote.instrument_id in self._candidate_ids
                else self._calculate_benchmark(quote)
            )
            self._snapshots[quote.instrument_id] = snapshot
            snapshots.append(snapshot)
        return snapshots

    def snapshots(self) -> list[FeatureSnapshot]:
        return sorted(self._snapshots.values(), key=lambda snapshot: snapshot.symbol)

    def snapshot(self, instrument_id: UUID) -> FeatureSnapshot | None:
        return self._snapshots.get(instrument_id)

    def _calculate(self, quote: QuoteRecord) -> FeatureSnapshot:
        session = self._require_session()
        series = self._candle_series.get(quote.instrument_id, {})
        one_minute_series = series.get("OneMinute", [])
        five_minute_series = series.get("FiveMinutes", [])
        cache_key = (
            session.market_id,
            str(quote.instrument_id),
            "FiveMinutes",
            WILDER_RSI_14_VERSION,
            14,
            len(one_minute_series),
            len(five_minute_series),
            len(series.get("OneDay", [])),
            quote.timestamp.replace(second=0, microsecond=0),
        )
        cached = self._feature_cache.get(quote.instrument_id)
        if cached is not None and cached[0] == cache_key:
            derived = cached[1]
        else:
            current_start = _bisect_candle_start(one_minute_series, session.start_time)
            current_end = _bisect_candle_end(one_minute_series, quote.timestamp)
            current_one_minute = [
                candle
                for candle in one_minute_series[current_start:current_end]
                if candle.is_complete
            ]
            all_five_minute = _regular_session_candles(
                _completed_candles(five_minute_series, quote.timestamp), session
            )
            five_minute = [candle for candle in all_five_minute if candle.start >= session.start_time]
            daily = [
                candle
                for candle in series.get("OneDay", [])
                if candle.is_complete and candle.end <= session.start_time
            ]
            rsi_values = rsi_by_bar(all_five_minute, 14)
            rsi_bar = all_five_minute[-1] if all_five_minute else None
            ema = daily_ema_context(daily)
            # The trailing-history argument only feeds _rvol's fallback when an instrument has
            # no captured historical sessions. Every historical candle is already retained in
            # _historical_one_minute, so pass an empty list instead of materializing the 45-day
            # one-minute prefix for every cache miss.
            current_volume, historical_mean, rvol = _rvol(
                [],
                current_one_minute,
                session.start_time,
                quote.timestamp,
                self._historical_one_minute.get(quote.instrument_id),
            )
            atr_14 = _atr(daily, 14)
            swing_highs, swing_lows = _confirmed_swings(five_minute)
            last_3_above, vwap_slope, touch, reclaim, rejection = _vwap_structure(
                current_one_minute, five_minute
            )
            derived = _CandleFeatures(
                one_minute=current_one_minute,
                five_minute=five_minute,
                daily=daily,
                vwap=_vwap(current_one_minute),
                atr_14=atr_14,
                current_volume=current_volume,
                historical_mean=historical_mean,
                rvol=rvol,
                opening_range=_opening_range(
                    current_one_minute,
                    _session_clock(session, session.opening_range.start),
                    _session_clock(session, session.opening_range.end),
                    quote.timestamp,
                    atr_14,
                ),
                swing_highs=swing_highs,
                swing_lows=swing_lows,
                last_3_above=last_3_above,
                vwap_slope=vwap_slope,
                touch_vwap=touch,
                vwap_reclaim=reclaim,
                vwap_rejection=rejection,
                rolling_baseline_5m=_rolling_baseline(
                    current_one_minute, quote.timestamp, minutes=5
                ),
                rsi_by_bar=rsi_values,
                rsi_14=None if rsi_bar is None else rsi_values.get(rsi_bar.end),
                rsi_timestamp=None if rsi_bar is None else rsi_bar.end,
                daily_ema_context=DailyEMAContextFeature(
                    status=ema.status,
                    ema13=ema.ema13,
                    ema21=ema.ema21,
                    slope13=ema.slope13,
                    slope21=ema.slope21,
                    source_timestamp=ema.source_timestamp,
                    reason=ema.reason,
                ),
            )
            self._feature_cache[quote.instrument_id] = (cache_key, derived)

        current_one_minute = derived.one_minute
        five_minute = derived.five_minute
        daily = derived.daily
        vwap = derived.vwap
        atr_14 = derived.atr_14
        current_volume = derived.current_volume
        historical_mean = derived.historical_mean
        rvol = derived.rvol
        opening_range = derived.opening_range
        swing_highs = derived.swing_highs
        swing_lows = derived.swing_lows

        mid = (quote.bid + quote.ask) / 2
        spread_absolute = quote.ask - quote.bid
        spread_pct = spread_absolute / mid * 100
        change_from_open_pct = (quote.last - quote.day_open) / quote.day_open * 100
        rolling_return_5m_pct = _return_from_baseline(
            derived.rolling_baseline_5m, quote.last
        )
        distance_from_vwap_pct = None if vwap is None else (quote.last - vwap) / vwap * 100
        close_above_vwap = None if vwap is None else quote.last > vwap
        atr_pct = None if atr_14 is None else atr_14 / quote.last * 100
        last_3_above = derived.last_3_above
        vwap_slope = derived.vwap_slope
        touch = derived.touch_vwap
        reclaim = derived.vwap_reclaim
        rejection = derived.vwap_rejection

        support_candidates: list[FeatureLevel] = []
        resistance_candidates: list[FeatureLevel] = []
        if vwap is not None:
            _add_level(support_candidates, resistance_candidates, quote.last, vwap, "VWAP", 0.85, 0, 0)
        if opening_range is not None:
            _add_level(support_candidates, resistance_candidates, quote.last, opening_range.high, "OPENING_RANGE_HIGH", 0.8, 1, max(0, len(five_minute) - 3))
            _add_level(support_candidates, resistance_candidates, quote.last, opening_range.low, "OPENING_RANGE_LOW", 0.75, 1, max(0, len(five_minute) - 3))
        for level in [*swing_lows, *swing_highs]:
            _add_level(
                support_candidates,
                resistance_candidates,
                quote.last,
                level.price,
                level.type,
                level.strength,
                level.tests,
                level.age_bars,
                level.provenance,
            )
        if current_one_minute:
            _add_level(support_candidates, resistance_candidates, quote.last, max(candle.high for candle in current_one_minute), "INTRADAY_HIGH", 0.7, 1, 0)
        if daily:
            _add_level(support_candidates, resistance_candidates, quote.last, daily[-1].high, "PRIOR_DAY_HIGH", 0.8, 1, 1)

        nearest_support = max(support_candidates, key=lambda level: level.price, default=None)
        nearest_resistance = min(resistance_candidates, key=lambda level: level.price, default=None)
        all_levels = [*support_candidates, *resistance_candidates]
        support_confluence = None if nearest_support is None else _confluence(all_levels, nearest_support.price)
        resistance_confluence = None if nearest_resistance is None else _confluence(all_levels, nearest_resistance.price)
        distance_from_vwap_atr = None if vwap is None or not atr_14 else (quote.last - vwap) / atr_14
        distance_from_orh_atr = None if opening_range is None or not atr_14 else (quote.last - opening_range.high) / atr_14
        change_from_open_atr = None if atr_pct is None or atr_pct == 0 else change_from_open_pct / atr_pct
        warming_up: list[str] = []
        if vwap is None:
            warming_up.append("VWAP")
        if atr_14 is None:
            warming_up.append("ATR_14")
        if rvol is None:
            warming_up.append("RVOL_AT_TIME")
        if opening_range is None or not opening_range.complete:
            warming_up.append("OPENING_RANGE")

        return FeatureSnapshot(
            market_id=session.market_id,
            instrument_id=quote.instrument_id,
            symbol=quote.symbol,
            timestamp=quote.timestamp,
            feature_version=FEATURE_VERSION,
            config_version=CONFIG_VERSION,
            data_status=quote.data_status,
            actionable=quote.actionable,
            price=quote.last,
            bid=quote.bid,
            ask=quote.ask,
            mid=mid,
            spread_absolute=spread_absolute,
            spread_pct=spread_pct,
            change_from_open_pct=change_from_open_pct,
            rolling_return_5m_pct=rolling_return_5m_pct,
            vwap=vwap,
            completed_bar_vwap=_vwap([bar for bar in current_one_minute if bar.end <= five_minute[-1].end]) if five_minute else None,
            completed_bar_vwap_timestamp=five_minute[-1].end if five_minute else None,
            distance_from_vwap_pct=distance_from_vwap_pct,
            close_above_vwap=close_above_vwap,
            last_3_closes_above_vwap=last_3_above,
            vwap_slope_pct=vwap_slope,
            touch_vwap=touch,
            vwap_reclaim=reclaim,
            vwap_rejection=rejection,
            rsi_14=derived.rsi_14,
            rsi_timestamp=derived.rsi_timestamp,
            daily_ema_context=derived.daily_ema_context,
            atr_14=atr_14,
            atr_pct=atr_pct,
            rvol_at_time=rvol,
            current_cumulative_volume=current_volume,
            historical_mean_cumulative_volume=historical_mean,
            opening_range=opening_range,
            swing_highs=swing_highs,
            swing_lows=swing_lows,
            nearest_support=nearest_support,
            nearest_resistance=nearest_resistance,
            support_confluence=support_confluence,
            resistance_confluence=resistance_confluence,
            distance_from_vwap_atr=distance_from_vwap_atr,
            distance_from_orh_atr=distance_from_orh_atr,
            change_from_open_atr=change_from_open_atr,
            consecutive_green_candles=_consecutive_green(five_minute),
            recent_move_velocity_atr=_move_velocity(five_minute, atr_14),
            warming_up=warming_up,
        )

    def _calculate_benchmark(self, quote: QuoteRecord) -> FeatureSnapshot:
        """Build only the fields consumed by benchmark context observations during replay."""
        session = self._require_session()
        series = self._candle_series.get(quote.instrument_id, {})
        mid = (quote.bid + quote.ask) / 2
        spread_absolute = quote.ask - quote.bid
        # This object is internal replay state, not an API boundary. Avoid Pydantic validation for
        # every benchmark quote; all values are derived from the already validated QuoteRecord.
        return FeatureSnapshot.model_construct(
            market_id=session.market_id,
            instrument_id=quote.instrument_id,
            symbol=quote.symbol,
            timestamp=quote.timestamp,
            feature_version=FEATURE_VERSION,
            config_version=CONFIG_VERSION,
            data_status=quote.data_status,
            actionable=quote.actionable,
            price=quote.last,
            bid=quote.bid,
            ask=quote.ask,
            mid=mid,
            spread_absolute=spread_absolute,
            spread_pct=spread_absolute / mid * 100,
            change_from_open_pct=(quote.last - quote.day_open) / quote.day_open * 100,
            rolling_return_5m_pct=_return_from_baseline(
                _last_completed_close(
                    series.get("OneMinute", []),
                    quote.timestamp - timedelta(minutes=5),
                ),
                quote.last,
            ),
            vwap=None,
            distance_from_vwap_pct=None,
            close_above_vwap=None,
            last_3_closes_above_vwap=0,
            vwap_slope_pct=None,
            touch_vwap=False,
            vwap_reclaim=False,
            vwap_rejection=False,
            atr_14=None,
            atr_pct=None,
            rvol_at_time=None,
            current_cumulative_volume=quote.volume,
            historical_mean_cumulative_volume=None,
            opening_range=None,
            swing_highs=[],
            swing_lows=[],
            nearest_support=None,
            nearest_resistance=None,
            support_confluence=None,
            resistance_confluence=None,
            distance_from_vwap_atr=None,
            distance_from_orh_atr=None,
            change_from_open_atr=None,
            consecutive_green_candles=0,
            recent_move_velocity_atr=None,
            warming_up=[],
        )

    def _require_session(self) -> SessionStart:
        if self._session is None:
            raise RuntimeError("Feature engine session has not started")
        return self._session

    def _validate_instrument(self, instrument_id: UUID, symbol: str) -> None:
        configured = self._instruments.get(instrument_id)
        if configured is None or configured.symbol != symbol:
            raise ValueError(f"Unknown session instrument: {symbol}")


def _vwap(candles: list[CandleRecord]) -> float | None:
    total_volume = sum(candle.volume for candle in candles)
    if total_volume <= 0:
        return None
    weighted = sum(((candle.high + candle.low + candle.close) / 3) * candle.volume for candle in candles)
    return weighted / total_volume


def _bisect_candle_start(candles: list[CandleRecord], start: datetime) -> int:
    """Return the insertion point for a candle in a start-time ordered series."""
    low = 0
    high = len(candles)
    while low < high:
        middle = (low + high) // 2
        if candles[middle].start < start:
            low = middle + 1
        else:
            high = middle
    return low


def _completed_candles(candles: list[CandleRecord], timestamp: datetime) -> list[CandleRecord]:
    """Return complete candles ending at or before timestamp without rescanning trailing history."""
    low = 0
    high = len(candles)
    while low < high:
        middle = (low + high) // 2
        if candles[middle].end <= timestamp:
            low = middle + 1
        else:
            high = middle
    return [candle for candle in candles[:low] if candle.is_complete]


def _bisect_candle_end(candles: list[CandleRecord], timestamp: datetime) -> int:
    """Return the first index whose candle ends after timestamp in a start-ordered series."""
    low = 0
    high = len(candles)
    while low < high:
        middle = (low + high) // 2
        if candles[middle].end <= timestamp:
            low = middle + 1
        else:
            high = middle
    return low


def _last_completed_close(candles: list[CandleRecord], boundary: datetime) -> float | None:
    """Close of the newest complete candle ending at or before boundary with a positive close.

    Equivalent to reducing the completed-candle prefix with :func:`_rolling_baseline` but
    without materializing the retained 45-day history for every replay quote."""
    index = _bisect_candle_end(candles, boundary)
    for position in range(index - 1, -1, -1):
        candle = candles[position]
        if candle.is_complete and candle.close > 0:
            return candle.close
    return None


def _rolling_return(candles: list[CandleRecord], price: float, timestamp: datetime, minutes: int) -> float | None:
    """Return from the last completed bar at or before the horizon boundary.

    Completed-candle selection keeps live and replay evaluation look-ahead free.
    The value stays unavailable during warm-up instead of substituting the open.
    """
    return _return_from_baseline(_rolling_baseline(candles, timestamp, minutes), price)


def _rolling_baseline(
    candles: list[CandleRecord], timestamp: datetime, minutes: int
) -> float | None:
    boundary = timestamp - timedelta(minutes=minutes)
    eligible = [candle for candle in candles if candle.end <= boundary and candle.close > 0]
    if not eligible:
        return None
    return max(eligible, key=lambda candle: candle.end).close


def _return_from_baseline(baseline: float | None, price: float) -> float | None:
    if baseline is None or baseline <= 0:
        return None
    return (price - baseline) / baseline * 100


def _atr(daily: list[CandleRecord], period: int) -> float | None:
    if len(daily) < period + 1:
        return None
    true_ranges = [
        max(current.high - current.low, abs(current.high - previous.close), abs(current.low - previous.close))
        for previous, current in zip(daily, daily[1:])
    ]
    atr = fmean(true_ranges[:period])
    for true_range in true_ranges[period:]:
        atr = ((atr * (period - 1)) + true_range) / period
    return atr


def _rvol(
    all_one_minute: list[CandleRecord],
    current: list[CandleRecord],
    session_start: datetime,
    timestamp: datetime,
    historical_sessions: dict[date, list[CandleRecord]] | None = None,
) -> tuple[int, float | None, float | None]:
    elapsed = max(timedelta(0), timestamp - session_start)
    current_volume = sum(candle.volume for candle in current if candle.end <= timestamp)
    sessions = historical_sessions
    if sessions is None:
        sessions = defaultdict(list)
        for candle in all_one_minute:
            if candle.start < session_start:
                sessions[candle.start.date()].append(candle)
    historical: list[tuple[date, int]] = []
    for session_date, candles in sessions.items():
        start = min(candle.start for candle in candles)
        volume = sum(candle.volume for candle in candles if candle.end <= start + elapsed)
        historical.append((session_date, volume))
    historical.sort(key=lambda item: item[0], reverse=True)
    volumes = [volume for _date, volume in historical[:10]]
    if len(volumes) < 10:
        return current_volume, None, None
    mean_volume = fmean(volumes)
    return current_volume, mean_volume, None if mean_volume <= 0 else current_volume / mean_volume


def _opening_range(candles: list[CandleRecord], start: datetime, end: datetime, timestamp: datetime, atr: float | None) -> OpeningRangeFeature | None:
    bars = [candle for candle in candles if start <= candle.start < end]
    if not bars:
        return None
    high = max(candle.high for candle in bars)
    low = min(candle.low for candle in bars)
    mid = (high + low) / 2
    width = high - low
    # Questrade omits one-minute candles for minutes with no trades. Requiring
    # one row per wall-clock minute therefore leaves a valid opening range in
    # WARMING forever for otherwise tradable symbols. Once the configured
    # window has elapsed, the observed traded bars fully define its high, low,
    # and volume; liquidity remains independently gated by RVOL and spread.
    return OpeningRangeFeature(high=high, low=low, mid=mid, width=width, width_pct=0 if mid == 0 else width / mid * 100, width_atr=None if not atr else width / atr, volume=sum(candle.volume for candle in bars), complete=timestamp >= end)


def _session_clock(session: SessionStart, value: str) -> datetime:
    hours, minutes = (int(part) for part in value.split(":"))
    local_start = session.start_time.astimezone(ZoneInfo(session.timezone))
    return local_start.replace(hour=hours, minute=minutes, second=0, microsecond=0)


def _regular_session_candles(candles: list[CandleRecord], session: SessionStart) -> list[CandleRecord]:
    """Keep completed candles whose local interval is inside the session hours.

    Historical intraday retention may include pre/post-market rows. RSI warmup
    must not let those rows influence regular-session pivots or indicator state.
    """

    local_start = session.start_time.astimezone(ZoneInfo(session.timezone))
    local_end = session.end_time.astimezone(ZoneInfo(session.timezone))
    start_minutes = local_start.hour * 60 + local_start.minute
    end_minutes = local_end.hour * 60 + local_end.minute
    return [
        candle
        for candle in candles
        if start_minutes <= (
            candle.start.astimezone(ZoneInfo(session.timezone)).hour * 60
            + candle.start.astimezone(ZoneInfo(session.timezone)).minute
        )
        and (
            candle.end.astimezone(ZoneInfo(session.timezone)).hour * 60
            + candle.end.astimezone(ZoneInfo(session.timezone)).minute
        )
        <= end_minutes
    ]


def _vwap_structure(one_minute: list[CandleRecord], five_minute: list[CandleRecord]) -> tuple[int, float | None, bool, bool, bool]:
    if not five_minute:
        return 0, None, False, False, False
    points: list[tuple[CandleRecord, float]] = []
    for candle in five_minute[-3:]:
        value = _vwap([bar for bar in one_minute if bar.end <= candle.end])
        if value is not None:
            points.append((candle, value))
    above = sum(candle.close > value for candle, value in points)
    slope = None if len(points) < 2 or points[0][1] == 0 else (points[-1][1] - points[0][1]) / points[0][1] * 100
    latest = five_minute[-1]
    latest_vwap = points[-1][1] if points and points[-1][0] == latest else _vwap([bar for bar in one_minute if bar.end <= latest.end])
    if latest_vwap is None:
        return above, slope, False, False, False
    tolerance = latest_vwap * 0.0015
    touch = latest.low <= latest_vwap + tolerance and latest.high >= latest_vwap - tolerance
    reclaim = False
    rejection = False
    if len(five_minute) >= 2:
        previous = five_minute[-2]
        previous_vwap = _vwap([bar for bar in one_minute if bar.end <= previous.end])
        if previous_vwap is not None:
            reclaim = previous.close <= previous_vwap and latest.close > latest_vwap
            rejection = previous.low <= previous_vwap + tolerance and latest.close > previous.high
    return above, slope, touch, reclaim, rejection


def _confirmed_swings(candles: list[CandleRecord]) -> tuple[list[FeatureLevel], list[FeatureLevel]]:
    highs: list[FeatureLevel] = []
    lows: list[FeatureLevel] = []
    for index in range(2, len(candles) - 2):
        candle = candles[index]
        age = len(candles) - 1 - index
        if candle.high > candles[index - 1].high and candle.high > candles[index - 2].high and candle.high >= candles[index + 1].high and candle.high >= candles[index + 2].high:
            tests = _level_tests(candles, candle.high, "high")
            highs.append(
                FeatureLevel(
                    price=candle.high,
                    type="SWING_HIGH",
                    strength=_strength(tests, age),
                    tests=tests,
                    age_bars=age,
                    provenance=_swing_provenance(candles, index, "SWING_HIGH"),
                )
            )
        if candle.low < candles[index - 1].low and candle.low < candles[index - 2].low and candle.low <= candles[index + 1].low and candle.low <= candles[index + 2].low:
            tests = _level_tests(candles, candle.low, "low")
            lows.append(
                FeatureLevel(
                    price=candle.low,
                    type="SWING_LOW",
                    strength=_strength(tests, age),
                    tests=tests,
                    age_bars=age,
                    provenance=_swing_provenance(candles, index, "SWING_LOW"),
                )
            )
    return highs, lows


def _level_tests(candles: list[CandleRecord], price: float, field: str) -> int:
    return 0 if price == 0 else sum(abs(getattr(candle, field) - price) / price <= 0.001 for candle in candles)


def _strength(tests: int, age: int) -> float:
    return max(0.0, min(1.0, 0.45 + min(tests, 4) * 0.1 - min(age, 20) * 0.01))


def _swing_provenance(
    candles: list[CandleRecord], index: int, kind: str
) -> FeatureLevelProvenance:
    origin = candles[index]
    return FeatureLevelProvenance(
        level_id=f"{origin.instrument_id}:{origin.timeframe}:{kind}:{origin.end.isoformat()}",
        origin_at=origin.end,
        available_at=candles[index + 2].end,
    )


def _add_level(
    supports: list[FeatureLevel],
    resistances: list[FeatureLevel],
    current_price: float,
    price: float,
    level_type: str,
    strength: float,
    tests: int,
    age: int,
    provenance: FeatureLevelProvenance | None = None,
) -> None:
    level = FeatureLevel(
        price=price,
        type=level_type,
        strength=strength,
        tests=tests,
        age_bars=age,
        provenance=provenance,
    )
    if price <= current_price:
        supports.append(level)
    if price > current_price:
        resistances.append(level)


# How close two levels (e.g. a swing high and the opening range high) must sit to count
# as the same confluence zone rather than two independent, coincidentally nearby levels.
CONFLUENCE_TOLERANCE_PCT = 0.15


def _confluence(levels: list[FeatureLevel], anchor_price: float) -> LevelConfluence | None:
    if anchor_price <= 0:
        return None
    tolerance = anchor_price * CONFLUENCE_TOLERANCE_PCT / 100
    nearby = [level for level in levels if abs(level.price - anchor_price) <= tolerance]
    if not nearby:
        return None
    level_types = sorted({level.type for level in nearby})
    return LevelConfluence(price=anchor_price, level_types=level_types, count=len(level_types))


def _consecutive_green(candles: list[CandleRecord]) -> int:
    count = 0
    for candle in reversed(candles):
        if candle.close <= candle.open:
            break
        count += 1
    return count


def _move_velocity(candles: list[CandleRecord], atr: float | None) -> float | None:
    if not atr or len(candles) < 4:
        return None
    return (candles[-1].close - candles[-4].close) / atr
