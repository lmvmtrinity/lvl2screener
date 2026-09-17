import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import ScannerConfig
from app.feature_engine import FeatureEngine
from app.main import create_app
from app.models import BenchmarkRef, CandleRecord, InstrumentRef, QuoteRecord, ScannerProfileConfig, SessionStart

INSTRUMENT_ID = UUID("11111111-1111-4111-8111-111111111111")
BENCHMARK_ID = UUID("33333333-3333-4333-8333-333333333333")
SESSION_START = datetime(2026, 8, 24, 13, 30, tzinfo=UTC)


def session() -> SessionStart:
    return SessionStart(
        market="TSX",
        timezone="America/Toronto",
        start_time=SESSION_START,
        end_time=SESSION_START + timedelta(hours=6, minutes=30),
        instruments=[InstrumentRef(instrument_id=INSTRUMENT_ID, symbol="TEST.TO")],
    )


def benchmark_session() -> SessionStart:
    return SessionStart(
        market="TSX",
        timezone="America/Toronto",
        start_time=SESSION_START,
        end_time=SESSION_START + timedelta(hours=6, minutes=30),
        instruments=[
            InstrumentRef(instrument_id=INSTRUMENT_ID, symbol="TEST.TO"),
            InstrumentRef(
                instrument_id=BENCHMARK_ID,
                symbol="XCD.TO",
                role="BENCHMARK",
                benchmark_kind="MARKET",
            ),
        ],
        benchmarks=[BenchmarkRef(kind="MARKET", symbol="XCD.TO")],
        profiles=[
            ScannerProfileConfig(
                profileId=UUID(int=60),
                profileName="Market context",
                strategy="MARKET_RELATIVE_STRENGTH",
                analysisKind="CONTEXT",
                configVersion="benchmark-regression-v1",
            ),
        ],
    )


def daily_history() -> list[CandleRecord]:
    candles = []
    for index in range(15):
        start = SESSION_START - timedelta(days=21 - index)
        price = 100 + index
        candles.append(
            CandleRecord(
                instrument_id=INSTRUMENT_ID,
                symbol="TEST.TO",
                timeframe="OneDay",
                start=start,
                end=start + timedelta(hours=6),
                open=price,
                high=price + 1,
                low=price - 1,
                close=price + 0.5,
                volume=1_000_000,
                is_complete=True,
            )
        )
    return candles


def minute_history() -> list[CandleRecord]:
    candles = []
    for day in range(10, 0, -1):
        start = SESSION_START - timedelta(days=day)
        for minute in range(30):
            candles.append(minute_candle(start, minute, 110, 100))
    for minute in range(30):
        candles.append(minute_candle(SESSION_START, minute, 111 + minute * 0.01, 200))
    return candles


def minute_candle(start: datetime, minute: int, price: float, volume: int) -> CandleRecord:
    candle_start = start + timedelta(minutes=minute)
    return CandleRecord(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        timeframe="OneMinute",
        start=candle_start,
        end=candle_start + timedelta(minutes=1),
        open=price,
        high=price + 0.2,
        low=price - 0.2,
        close=price + 0.1,
        volume=volume,
        is_complete=True,
    )


def five_minute_history(count: int = 6) -> list[CandleRecord]:
    highs = [111, 112, 114, 112, 111, 113]
    lows = [109, 108, 107, 108, 109, 108]
    candles = []
    for index in range(count):
        start = SESSION_START + timedelta(minutes=index * 5)
        candles.append(
            CandleRecord(
                instrument_id=INSTRUMENT_ID,
                symbol="TEST.TO",
                timeframe="FiveMinutes",
                start=start,
                end=start + timedelta(minutes=5),
                open=110 + index * 0.1,
                high=highs[index],
                low=lows[index],
                close=110.2 + index * 0.1,
                volume=1_000,
                is_complete=True,
            )
        )
    return candles


def quote() -> QuoteRecord:
    return QuoteRecord(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        timestamp=SESSION_START + timedelta(minutes=30),
        bid=112,
        ask=112.02,
        bid_size=1_200,
        ask_size=800,
        spread=0.02,
        last=112.01,
        day_open=111,
        day_high=114,
        day_low=107,
        volume=6_000,
        data_status="REALTIME",
        actionable=True,
    )


def invalid_benchmark_quote() -> QuoteRecord:
    return QuoteRecord(
        instrument_id=BENCHMARK_ID,
        symbol="XCD.TO",
        timestamp=SESSION_START + timedelta(minutes=30),
        bid=25.10,
        ask=25.12,
        bid_size=1_000,
        ask_size=1_000,
        spread=0.02,
        last=25.11,
        day_open=0,
        day_high=0,
        day_low=0,
        volume=0,
        data_status="REALTIME",
        actionable=True,
    )


def warmed_engine() -> FeatureEngine:
    engine = FeatureEngine()
    engine.start_session(session())
    engine.ingest_candles([*daily_history(), *minute_history(), *five_minute_history()])
    return engine


def warmed_engine_with_benchmark() -> FeatureEngine:
    engine = FeatureEngine()
    engine.start_session(benchmark_session())
    engine.ingest_candles([*daily_history(), *minute_history(), *five_minute_history()])
    return engine


def test_invalid_benchmark_quote_does_not_abort_valid_candidate_processing() -> None:
    engine = warmed_engine_with_benchmark()

    snapshots = engine.ingest_quotes([invalid_benchmark_quote(), quote()])

    assert [snapshot.symbol for snapshot in snapshots] == ["TEST.TO"]
    readiness = engine.benchmark_readiness()
    assert readiness.market is not None
    assert readiness.market.status == "UNAVAILABLE"
    assert readiness.market.reason == "INVALID_QUOTE_VALUES"
    context = engine.strategies.evaluate(
        snapshots[0], engine.strategy_context(snapshots[0])
    )[2][0]
    assert context.status == "UNAVAILABLE"
    assert context.missing_data_flags == ["BENCHMARK_SESSION_RETURN_UNAVAILABLE"]


def test_candidate_quote_validation_remains_fatal() -> None:
    engine = warmed_engine_with_benchmark()
    invalid_candidate = quote().model_copy(update={"day_open": 0})

    with pytest.raises(ValueError, match="Invalid quote values for TEST.TO"):
        engine.ingest_quotes([invalid_candidate])


def test_calculates_deterministic_phase_3_snapshot() -> None:
    engine = warmed_engine()
    first = engine.ingest_quotes([quote()])[0]
    second = engine.ingest_quotes([quote()])[0]

    assert first == second
    assert first.spread_pct == pytest.approx((0.02 / 112.01) * 100)
    assert first.change_from_open_pct == pytest.approx((1.01 / 111) * 100)
    assert first.rolling_return_5m_pct == pytest.approx((112.01 - 111.34) / 111.34 * 100)
    assert first.atr_14 == pytest.approx(2.0)
    assert first.rvol_at_time == pytest.approx(2.0)
    assert first.opening_range is not None
    assert first.opening_range.complete is True
    assert first.opening_range.volume == 3_000
    assert first.vwap is not None
    assert first.swing_highs[0].price == 114
    assert first.swing_lows[0].price == 107
    assert first.warming_up == []


def test_new_snapshot_retains_available_level_provenance_without_reconstructing_legacy() -> None:
    from app.models import FeatureSnapshot

    engine = warmed_engine()
    snapshot = engine.ingest_quotes([quote()])[0]
    assert snapshot.feature_version == "1.2.0"
    assert snapshot.swing_highs
    for level in [*snapshot.swing_highs, *snapshot.swing_lows]:
        assert level.provenance is not None
        assert level.provenance.available_at <= snapshot.timestamp
    for level in [snapshot.nearest_support, snapshot.nearest_resistance]:
        if level is not None and level.type in {"SWING_HIGH", "SWING_LOW"}:
            assert level.provenance is not None
    retained = FeatureSnapshot.model_validate_json(snapshot.model_dump_json(by_alias=True))
    assert retained.swing_highs == snapshot.swing_highs
    legacy = snapshot.model_dump(by_alias=True)
    legacy["featureVersion"] = "1.1.0"
    for key in ["swingHighs", "swingLows"]:
        for level in legacy[key]:
            level.pop("provenance", None)
    assert all(
        level.provenance is None
        for level in FeatureSnapshot.model_validate(legacy).swing_highs
    )


def test_replacing_a_historical_candle_does_not_duplicate_cached_rvol_inputs() -> None:
    engine = FeatureEngine()
    engine.start_session(session())
    historical = minute_history()[0]
    engine.ingest_candles([historical])
    replacement = historical.model_copy(update={"close": historical.close + 1})
    engine.ingest_candles([replacement])

    cached = engine._historical_one_minute[INSTRUMENT_ID][historical.start.date()]
    assert len(cached) == 1
    assert cached[0].close == replacement.close


def test_incremental_candidate_warmup_preserves_existing_session_state() -> None:
    engine = warmed_engine()
    snapshot = engine.ingest_quotes([quote()])[0]
    engine.strategies.evaluate(snapshot, engine.strategy_context(snapshot))
    existing_memory = dict(engine.strategies._memory)
    new_id = UUID("33333333-3333-4333-8333-333333333333")
    new_instrument = InstrumentRef(instrument_id=new_id, symbol="NEW.TO")
    new_candle = CandleRecord(
        instrument_id=new_id,
        symbol="NEW.TO",
        timeframe="OneDay",
        start=SESSION_START - timedelta(days=1),
        end=SESSION_START,
        open=100,
        high=101,
        low=99,
        close=100.5,
        volume=10_000,
        is_complete=True,
    )

    readiness = engine.warm_instrument(new_instrument, [new_candle])

    assert engine.is_candidate(new_id)
    assert engine._instruments[new_id] == new_instrument
    assert engine.strategies._memory == existing_memory
    assert engine._candles[(new_id, "OneDay", new_candle.start)] == new_candle
    assert readiness.ready is False
    assert "DAILY_HISTORY_UNAVAILABLE" in readiness.reasons
    assert "HISTORICAL_INTRADAY_HISTORY_UNAVAILABLE" in readiness.reasons
    assert "OPENING_RANGE_UNAVAILABLE" in readiness.reasons


@pytest.mark.parametrize("missing", [None, "opening", "history", "current", "future"])
def test_discovery_readiness_requires_continuous_session_coverage(missing: str | None) -> None:
    engine = FeatureEngine()
    engine.start_session(session())
    template = daily_history()[0]
    daily = [template.model_copy(update={
        "start": SESSION_START - timedelta(days=i),
        "end": SESSION_START - timedelta(days=i) + timedelta(hours=6),
    }) for i in range(1, 23)]
    history = [minute_candle(SESSION_START - timedelta(days=day), minute, 100, 100)
               for day in range(1, 11) for minute in range(30)]
    current = [minute_candle(SESSION_START, minute, 100, 100) for minute in range(30)]
    if missing == "opening":
        current = current[15:]
    elif missing == "history":
        history = [candle for candle in history if candle.start.minute == 30]
    elif missing == "current":
        current.pop(20)
    elif missing == "future":
        current = [minute_candle(SESSION_START, 60, 100, 100)]
    result = engine.warm_instrument(session().instruments[0], daily + history + current,
                                    SESSION_START + timedelta(minutes=30))
    assert result.ready is (missing is None)
    if missing in ("opening", "future"):
        assert not result.opening_range_complete
    if missing == "history":
        assert result.historical_intraday_session_count == 0


def test_swing_requires_two_future_completed_bars() -> None:
    engine = FeatureEngine()
    engine.start_session(session())
    engine.ingest_candles([*daily_history(), *minute_history(), *five_minute_history(4)])
    before_confirmation = engine.ingest_quotes([quote()])[0]
    assert before_confirmation.swing_highs == []
    assert before_confirmation.swing_lows == []

    engine.ingest_candles([five_minute_history(5)[-1]])
    after_confirmation = engine.ingest_quotes([quote()])[0]
    assert after_confirmation.swing_highs[0].price == 114
    assert after_confirmation.swing_lows[0].price == 107


def test_resistance_confluence_reports_a_single_type_when_nothing_else_is_nearby() -> None:
    engine = warmed_engine()
    snapshot = engine.ingest_quotes([quote()])[0]

    assert snapshot.nearest_resistance is not None
    assert snapshot.resistance_confluence is not None
    assert snapshot.resistance_confluence.price == snapshot.nearest_resistance.price
    assert snapshot.resistance_confluence.level_types == [snapshot.nearest_resistance.type]
    assert snapshot.resistance_confluence.count == 1


def test_level_confluence_dedupes_coincident_level_types_instead_of_double_counting() -> None:
    from app.feature_engine import _confluence
    from app.models import FeatureLevel

    levels = [
        FeatureLevel(price=100.05, type="OPENING_RANGE_HIGH", strength=0.8, tests=1, age_bars=0),
        FeatureLevel(price=100.02, type="SWING_HIGH", strength=0.6, tests=1, age_bars=3),
        FeatureLevel(price=100.08, type="SWING_HIGH", strength=0.5, tests=1, age_bars=1),
        FeatureLevel(price=105, type="PRIOR_DAY_HIGH", strength=0.8, tests=1, age_bars=1),
    ]

    confluence = _confluence(levels, anchor_price=100)

    assert confluence is not None
    assert confluence.count == 2
    assert set(confluence.level_types) == {"OPENING_RANGE_HIGH", "SWING_HIGH"}


def test_level_confluence_is_none_when_nothing_is_nearby() -> None:
    from app.feature_engine import _confluence
    from app.models import FeatureLevel

    levels = [FeatureLevel(price=105, type="PRIOR_DAY_HIGH", strength=0.8, tests=1, age_bars=1)]

    assert _confluence(levels, anchor_price=100) is None
    assert _confluence(levels, anchor_price=0) is None


def test_missing_history_is_explicit_instead_of_fabricated() -> None:
    engine = FeatureEngine()
    engine.start_session(session())
    engine.ingest_candles([minute_candle(SESSION_START, 0, 111, 200)])
    early_quote = quote().model_copy(
        update={
            "timestamp": SESSION_START + timedelta(minutes=1),
            "data_status": "DELAYED",
            "actionable": False,
        }
    )

    snapshot = engine.ingest_quotes([early_quote])[0]
    assert snapshot.vwap is not None
    assert snapshot.rolling_return_5m_pct is None
    assert snapshot.atr_14 is None
    assert snapshot.rvol_at_time is None
    assert snapshot.opening_range is not None
    assert snapshot.opening_range.complete is False
    assert snapshot.actionable is False
    assert snapshot.warming_up == ["ATR_14", "RVOL_AT_TIME", "OPENING_RANGE"]


def test_opening_range_completes_when_provider_omits_zero_trade_minutes() -> None:
    engine = FeatureEngine()
    engine.start_session(session())
    history = minute_history()
    sparse_current_session = [
        candle
        for candle in history
        if candle.start < SESSION_START
        or candle.start.minute not in {2, 5, 7, 11, 14}
    ]
    engine.ingest_candles([*daily_history(), *sparse_current_session, *five_minute_history()])

    snapshot = engine.ingest_quotes([quote()])[0]

    assert snapshot.opening_range is not None
    assert snapshot.opening_range.complete is True
    assert "OPENING_RANGE" not in snapshot.warming_up


def test_internal_api_returns_camel_case_snapshot_contract() -> None:
    app = create_app(ScannerConfig("scanner", "0.3.0", "INFO"), warmed_engine())

    async def exercise() -> dict[str, object]:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/internal/v1/quotes/batch",
                json={"quotes": [quote().model_dump(mode="json", by_alias=True)]},
            )
            assert response.status_code == 200
            return response.json()["snapshots"][0]

    payload = asyncio.run(exercise())
    assert payload["instrumentId"] == str(INSTRUMENT_ID)
    assert payload["featureVersion"] == "1.2.0"
    assert payload["rvolAtTime"] == pytest.approx(2.0)
    assert payload["openingRange"]["complete"] is True  # type: ignore[index]


def test_internal_api_keeps_ca_and_us_sessions_isolated() -> None:
    app = create_app(ScannerConfig("scanner", "0.3.0", "INFO"), warmed_engine())
    us_id = UUID("22222222-2222-4222-8222-222222222222")
    us_session = SessionStart(
        market_id="US_EQUITIES",
        market="US",
        timezone="America/New_York",
        start_time=SESSION_START,
        end_time=SESSION_START + timedelta(hours=6, minutes=30),
        instruments=[InstrumentRef(instrument_id=us_id, symbol="AAPL")],
    )
    us_quote = quote().model_copy(update={"instrument_id": us_id, "symbol": "AAPL"})

    async def exercise() -> tuple[str, str]:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            started = await client.post(
                "/internal/v1/session/start",
                json=us_session.model_dump(mode="json", by_alias=True),
            )
            assert started.status_code == 204
            us_response = await client.post(
                "/internal/v1/quotes/batch",
                json={"marketId": "US_EQUITIES", "quotes": [us_quote.model_dump(mode="json", by_alias=True)]},
            )
            ca_response = await client.post(
                "/internal/v1/quotes/batch",
                json={"marketId": "CA_TSX", "quotes": [quote().model_dump(mode="json", by_alias=True)]},
            )
            assert us_response.status_code == 200
            assert ca_response.status_code == 200
            return us_response.json()["snapshots"][0]["symbol"], ca_response.json()["snapshots"][0]["symbol"]

    assert asyncio.run(exercise()) == ("AAPL", "TEST.TO")


def test_vwap_structure_completed_candle_invariance():
    from app.feature_engine import _vwap_structure
    start = SESSION_START
    one_m = []
    for m in range(10):
        t = start + timedelta(minutes=m)
        one_m.append(
            CandleRecord(
                instrument_id=INSTRUMENT_ID,
                symbol="TEST.TO",
                timeframe="OneMinute",
                start=t,
                end=t + timedelta(minutes=1),
                open=10.0,
                high=10.25,
                low=9.95,
                close=10.0 + m * 0.02,
                volume=1000,
                is_complete=True,
            )
        )
    five_m = [
        CandleRecord(
            instrument_id=INSTRUMENT_ID,
            symbol="TEST.TO",
            timeframe="FiveMinutes",
            start=start,
            end=start + timedelta(minutes=5),
            open=10.0,
            high=10.15,
            low=9.95,
            close=10.05,
            volume=5000,
            is_complete=True,
        ),
        CandleRecord(
            instrument_id=INSTRUMENT_ID,
            symbol="TEST.TO",
            timeframe="FiveMinutes",
            start=start + timedelta(minutes=5),
            end=start + timedelta(minutes=10),
            open=10.08,
            high=10.25,
            low=10.02,
            close=10.20,
            volume=5000,
            is_complete=True,
        ),
    ]
    res1 = _vwap_structure(one_m, five_m)

    # Add subsequent 1-minute bars (13:40 - 13:45) trading much higher with massive volume
    for m in range(10, 15):
        t = start + timedelta(minutes=m)
        one_m.append(
            CandleRecord(
                instrument_id=INSTRUMENT_ID,
                symbol="TEST.TO",
                timeframe="OneMinute",
                start=t,
                end=t + timedelta(minutes=1),
                open=15.0,
                high=16.0,
                low=14.5,
                close=15.5,
                volume=50000,
                is_complete=True,
            )
        )
    res2 = _vwap_structure(one_m, five_m)
    # Completed-bar touch, reclaim, rejection must remain identical
    assert res1[2:] == res2[2:]


def test_strategy_context_cache_matches_a_fresh_rebuild() -> None:
    engine = warmed_engine()
    snapshot = engine.ingest_quotes([quote()])[0]

    cached = engine.strategy_context(snapshot)
    engine._context_cache.clear()
    rebuilt = engine.strategy_context(snapshot)

    assert cached == rebuilt
    assert engine._context_cache


def test_strategy_context_reflects_replaced_five_minute_candle() -> None:
    engine = warmed_engine()
    snapshot = engine.ingest_quotes([quote()])[0]
    before = engine.strategy_context(snapshot)
    target = before.bars[-1]
    replacement = target.model_copy(update={"close": target.close + 5})

    engine.ingest_candles([replacement])
    after = engine.strategy_context(snapshot)

    assert before.bars[-1].close != replacement.close
    assert after.bars[-1].close == replacement.close


def test_strategy_context_reflects_new_prior_day_candle() -> None:
    engine = warmed_engine()
    snapshot = engine.ingest_quotes([quote()])[0]
    before = engine.strategy_context(snapshot)
    new_day = CandleRecord(
        instrument_id=INSTRUMENT_ID,
        symbol="TEST.TO",
        timeframe="OneDay",
        start=SESSION_START - timedelta(days=1),
        end=SESSION_START - timedelta(days=1) + timedelta(hours=6),
        open=200,
        high=250,
        low=190,
        close=240,
        volume=1_000_000,
        is_complete=True,
    )

    engine.ingest_candles([new_day])
    after = engine.strategy_context(snapshot)

    assert before.prior_day_high != 250
    assert after.prior_day_high == 250


def test_last_completed_close_matches_the_materialized_baseline() -> None:
    from app.feature_engine import (
        _completed_candles,
        _last_completed_close,
        _rolling_baseline,
    )

    series = minute_history()
    timestamp = SESSION_START + timedelta(minutes=20)
    completed = _completed_candles(series, timestamp)

    assert _last_completed_close(
        series, timestamp - timedelta(minutes=5)
    ) == _rolling_baseline(completed, timestamp, minutes=5)
