from copy import deepcopy
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.discovery import evaluate_discovery
from app.discovery_models import DiscoveryInput


def sample(market="CA_TSX", current_date=date(2026, 11, 3), offset=timedelta(minutes=10), holidays=()):
    timezone = ZoneInfo("America/Toronto" if market == "CA_TSX" else "America/New_York")
    dates = []
    cursor = current_date
    while len(dates) < 92:
        if cursor.weekday() < 5 and cursor not in holidays:
            dates.append(cursor)
        cursor -= timedelta(days=1)
    dates.reverse()
    sessions = [
        {
            "tradingDate": day.isoformat(),
            "open": datetime.combine(day, time(9, 30), timezone).astimezone(UTC),
            "close": datetime.combine(day, time(16), timezone).astimezone(UTC),
        }
        for day in dates
    ]
    boundary = sessions[-1]["open"] + offset
    at = boundary + timedelta(seconds=15)
    history = {
        "open": 50,
        "high": 51,
        "low": 49,
        "close": 50,
        "volume": 2_000_000,
        "complete": True,
        "source": "FIXTURE",
        "adjustmentRevision": "fixture-split-revision-1",
    }
    daily = [
        {**history, "tradingDate": session["tradingDate"], "observedAt": session["close"] + timedelta(seconds=1)}
        for session in sessions[:-1]
    ]
    slots = [
        {
            **history,
            "start": session["open"] + offset - timedelta(minutes=5),
            "end": session["open"] + offset,
            "observedAt": session["open"] + offset + timedelta(seconds=1),
            "volume": 100_000 if index < 10 else 200_000,
        }
        for index, session in enumerate(sessions[-11:])
    ]
    return {
        "marketId": market,
        "policyVersion": "ca-discovery-v1" if market == "CA_TSX" else "us-discovery-v1",
        "providerCode": "EXAMPLE",
        "providerExchange": "TSX" if market == "CA_TSX" else "NASDAQ",
        "tradingDate": current_date.isoformat(),
        "evaluationAt": at,
        "completedBarEnd": boundary,
        "identity": {
            "marketId": market,
            "symbolId": 123,
            "symbol": "EXAMPLE.TO" if market == "CA_TSX" else "EXAMPLE",
            "exchange": "TSX" if market == "CA_TSX" else "NASDAQ",
            "currency": "CAD" if market == "CA_TSX" else "USD",
            "classification": "COMMON_STOCK_REVIEWED",
            "observedAt": at,
            "source": "FIXTURE",
        },
        "marketCap": {
            "value": 2_000_000_000,
            "currency": "CAD" if market == "CA_TSX" else "USD",
            "observedAt": at,
            "source": "FIXTURE",
        },
        "quote": {
            "price": 50,
            "open": 49,
            "priceAt": at - timedelta(seconds=1),
            "observedAt": at,
            "delayed": False,
            "halted": False,
            "session": "REGULAR",
            "source": "FIXTURE",
        },
        "calendar": {
            "marketId": market,
            "verified": True,
            "revision": "synthetic-calendar-v1",
            "source": "FIXTURE",
            "observedAt": at,
            "sessions": sessions,
        },
        "adjustment": {
            "verified": True,
            "revision": "fixture-split-revision-1",
            "source": "FIXTURE",
            "convention": "SPLIT_ADJUSTED",
            "hasUnresolvedCorporateAction": False,
            "observedAt": at,
        },
        "dailyBars": daily,
        "slotBars": slots,
    }


def evaluate(payload):
    return evaluate_discovery(DiscoveryInput.model_validate(payload), payload["evaluationAt"])


@pytest.mark.parametrize("market", ["CA_TSX", "US_EQUITIES"])
def test_complete_independent_discovery(market):
    result = evaluate(sample(market))
    assert result.state == "PASS"
    assert result.reasons == []
    assert result.metrics.atr14.value == 2
    assert result.metrics.relative_volume.value == 2
    assert result.metrics.dollar_volume30d.value == 100_000_000


@pytest.mark.parametrize(
    "market,provider_exchange,broker_exchange",
    [
        ("CA_TSX", "TO", "TSX"),
        ("US_EQUITIES", "XNAS", "NASDAQ"),
        ("US_EQUITIES", "XNYS", "NYSE"),
    ],
)
def test_provider_exchange_aliases_match_the_market_specific_broker_exchange(
    market, provider_exchange, broker_exchange
):
    payload = sample(market)
    payload["providerExchange"] = provider_exchange
    payload["identity"]["exchange"] = broker_exchange

    result = evaluate(payload)

    assert result.state == "PASS"
    assert result.provider_exchange == provider_exchange


@pytest.mark.parametrize(
    "market,provider_exchange,broker_exchange",
    [
        ("CA_TSX", "TO", "NASDAQ"),
        ("CA_TSX", "XNAS", "TSX"),
        ("US_EQUITIES", "TO", "NASDAQ"),
        ("US_EQUITIES", "XNAS", "NYSE"),
        ("US_EQUITIES", "XNYS", "NASDAQ"),
    ],
)
def test_provider_exchange_aliases_do_not_match_cross_market_broker_exchanges(
    market, provider_exchange, broker_exchange
):
    payload = sample(market)
    payload["providerExchange"] = provider_exchange
    payload["identity"]["exchange"] = broker_exchange

    result = evaluate(payload)

    assert result.state == "UNEVALUABLE"
    assert "MAPPING_UNAVAILABLE" in result.reasons


def test_normalized_provider_exchange_preserves_the_raw_provider_value_in_the_result():
    payload = sample("US_EQUITIES")
    payload["providerExchange"] = "  xnas  "

    result = evaluate(payload)

    assert result.state == "PASS"
    assert result.provider_exchange == "  xnas  "


def test_unknown_provider_exchange_remains_mapping_unavailable():
    payload = sample()
    payload["providerExchange"] = "XTSX"

    result = evaluate(payload)

    assert result.state == "UNEVALUABLE"
    assert "MAPPING_UNAVAILABLE" in result.reasons
    assert result.provider_exchange == "XTSX"


def test_provider_exchange_alias_does_not_bypass_wrong_symbol_identity():
    payload = sample()
    payload["providerExchange"] = "TO"
    payload["identity"]["symbol"] = "EXAMPLE.A.TO"

    result = evaluate(payload)

    assert result.state == "UNEVALUABLE"
    assert "MAPPING_UNAVAILABLE" in result.reasons


@pytest.mark.parametrize("market,threshold", [("CA_TSX", 400_000_000), ("US_EQUITIES", 1_000_000_000)])
def test_cap_threshold_is_strict(market, threshold):
    payload = sample(market)
    payload["marketCap"]["value"] = threshold
    assert "MARKET_CAP_THRESHOLD" in evaluate(payload).reasons
    payload["marketCap"]["value"] += 1
    assert evaluate(payload).state == "PASS"


@pytest.mark.parametrize("market,threshold", [("CA_TSX", 400_000), ("US_EQUITIES", 1_000_000)])
def test_average_volume_threshold_is_strict(market, threshold):
    payload = sample(market)
    for bar in payload["dailyBars"]:
        bar["volume"] = threshold
    assert "AVERAGE_VOLUME_THRESHOLD" in evaluate(payload).reasons
    for bar in payload["dailyBars"]:
        bar["volume"] += 1
    assert "AVERAGE_VOLUME_THRESHOLD" not in evaluate(payload).reasons


@pytest.mark.parametrize("market,threshold", [("CA_TSX", 1.5), ("US_EQUITIES", 2)])
def test_atr_threshold_is_strict(market, threshold):
    payload = sample(market)
    half_range = threshold * 50 / 100 / 2
    for bar in payload["dailyBars"]:
        bar.update(high=50 + half_range, low=50 - half_range)
    assert "ATR_THRESHOLD" in evaluate(payload).reasons
    for bar in payload["dailyBars"]:
        bar["high"] += 0.0001
    assert evaluate(payload).state == "PASS"


@pytest.mark.parametrize("market,threshold", [("CA_TSX", 1.5), ("US_EQUITIES", 1.75)])
def test_slot_rvol_threshold_is_strict(market, threshold):
    payload = sample(market)
    payload["slotBars"][-1]["volume"] = 100_000 * threshold
    assert "RELATIVE_VOLUME_THRESHOLD" in evaluate(payload).reasons
    payload["slotBars"][-1]["volume"] += 1
    assert evaluate(payload).state == "PASS"


@pytest.mark.parametrize("market,threshold", [("CA_TSX", 0.75), ("US_EQUITIES", 1)])
def test_change_from_open_exact_threshold(market, threshold):
    payload = sample(market)
    payload["quote"].update(open=100, price=100 + threshold)
    assert "CHANGE_FROM_OPEN_THRESHOLD" in evaluate(payload).reasons
    payload["quote"]["price"] += 0.0001
    assert "CHANGE_FROM_OPEN_THRESHOLD" not in evaluate(payload).reasons


@pytest.mark.parametrize("market,threshold", [("CA_TSX", 15_000_000), ("US_EQUITIES", 50_000_000)])
def test_dollar_volume_uses_30_sessions_and_strict_threshold(market, threshold):
    payload = sample(market)
    for bar in payload["dailyBars"][-30:]:
        bar["volume"] = threshold / 50
    result = evaluate(payload)
    assert "DOLLAR_VOLUME_THRESHOLD" in result.reasons
    assert result.metrics.average_volume90d.value != result.metrics.average_volume30d.value
    for bar in payload["dailyBars"][-30:]:
        bar["volume"] += 1
    assert "DOLLAR_VOLUME_THRESHOLD" not in evaluate(payload).reasons


@pytest.mark.parametrize("market,price", [("CA_TSX", 5), ("CA_TSX", 150), ("US_EQUITIES", 10), ("US_EQUITIES", 200)])
def test_price_endpoints_are_inclusive(market, price):
    payload = sample(market)
    payload["quote"].update(price=price, open=price / 1.02)
    assert "PRICE_OUT_OF_RANGE" not in evaluate(payload).reasons
    payload["quote"]["price"] += -0.01 if price in (5, 10) else 0.01
    assert "PRICE_OUT_OF_RANGE" in evaluate(payload).reasons


@pytest.mark.parametrize(
    "section,field,value,reason",
    [
        ("identity", "marketId", "US_EQUITIES", "MARKET_MISMATCH"),
        ("identity", "currency", "USD", "CURRENCY_NOT_ALLOWED"),
        ("identity", "exchange", "TSXV", "EXCHANGE_NOT_ALLOWED"),
        ("identity", "classification", "UNKNOWN", "CLASSIFICATION_REVIEW_REQUIRED"),
        ("quote", "delayed", True, "QUOTE_DELAYED"),
        ("quote", "halted", True, "QUOTE_HALTED"),
        ("quote", "delayed", None, "QUOTE_UNAVAILABLE"),
        ("quote", "open", 0, "INVALID_OPEN"),
        ("quote", "session", "EXTENDED", "OUTSIDE_REGULAR_SESSION"),
        ("quote", "priceAt", None, "QUOTE_STALE"),
        ("calendar", "verified", False, "CALENDAR_UNVERIFIED"),
        ("adjustment", "verified", False, "ADJUSTMENT_UNVERIFIED"),
        ("adjustment", "hasUnresolvedCorporateAction", True, "ADJUSTMENT_UNVERIFIED"),
    ],
)
def test_unknown_and_wrong_context_is_unevaluable(section, field, value, reason):
    payload = sample()
    payload[section][field] = value
    result = evaluate(payload)
    assert result.state == "UNEVALUABLE"
    assert reason in result.reasons


def test_only_complete_prior_daily_bars_contribute():
    payload = sample()
    original = evaluate(payload)
    payload["dailyBars"].append(
        {**payload["dailyBars"][-1], "tradingDate": payload["tradingDate"], "complete": False, "volume": 999_999_999}
    )
    assert evaluate(payload) == original
    payload["dailyBars"][0]["complete"] = False
    assert "INSUFFICIENT_DAILY_HISTORY" in evaluate(payload).reasons


@pytest.mark.parametrize("series", ["dailyBars", "slotBars"])
def test_duplicates_missing_and_future_history(series):
    payload = sample()
    payload[series].append(deepcopy(payload[series][0]))
    assert "DUPLICATE_BAR" in evaluate(payload).reasons
    payload = sample()
    payload[series].pop(0)
    assert evaluate(payload).state == "UNEVALUABLE"
    payload = sample()
    payload[series][0]["observedAt"] = payload["evaluationAt"] + timedelta(seconds=1)
    assert "FUTURE_OBSERVATION" in evaluate(payload).reasons
    payload = sample()
    payload[series][0]["adjustmentRevision"] = "pre-split-revision"
    assert "ADJUSTMENT_UNVERIFIED" in evaluate(payload).reasons


def test_rvol_is_not_cumulative_and_slots_follow_session_open_across_dst():
    payload = sample()
    assert payload["slotBars"][-3]["start"].hour != payload["slotBars"][-1]["start"].hour
    original = evaluate(payload)
    opening = {
        **payload["slotBars"][-1],
        "start": payload["calendar"]["sessions"][-1]["open"],
        "end": payload["calendar"]["sessions"][-1]["open"] + timedelta(minutes=5),
        "volume": 1_000_000_000,
    }
    payload["slotBars"].append(opening)
    assert evaluate(payload) == original
    payload["slotBars"].pop()
    assert evaluate(payload).metrics.relative_volume.value == 2


def test_early_close_missing_slot_is_not_zero_or_replaced_by_an_older_day():
    payload = sample(offset=timedelta(hours=6))
    prior = payload["calendar"]["sessions"][-2]
    prior["close"] = prior["open"] + timedelta(hours=3, minutes=30)
    assert "INSUFFICIENT_SLOT_HISTORY" in evaluate(payload).reasons


def test_holiday_calendar_is_market_specific_and_missing_current_is_unknown():
    # Supplied verified calendars differ; the evaluator does not infer sessions
    # from weekdays or substitute US dates for Canadian dates.
    ca = sample("CA_TSX", date(2026, 7, 2), holidays=(date(2026, 7, 1),))
    us = sample("US_EQUITIES", date(2026, 7, 2))
    assert ca["calendar"]["sessions"][-2]["tradingDate"] == "2026-06-30"
    assert us["calendar"]["sessions"][-2]["tradingDate"] == "2026-07-01"
    assert evaluate(ca).state == evaluate(us).state == "PASS"
    ca["slotBars"][-2] = us["slotBars"][-2]
    assert "INSUFFICIENT_SLOT_HISTORY" in evaluate(ca).reasons
    payload = sample()
    payload["calendar"]["sessions"].pop()
    assert "CALENDAR_UNVERIFIED" in evaluate(payload).reasons


def test_zero_slot_baseline_is_unknown():
    payload = sample()
    for bar in payload["slotBars"][:-1]:
        bar["volume"] = 0
    assert "ZERO_SLOT_BASELINE" in evaluate(payload).reasons


def test_publication_delay_latest_completed_slot_and_expiry():
    payload = sample()
    payload["evaluationAt"] = payload["completedBarEnd"] + timedelta(seconds=14)
    assert "INVALID_EVALUATION_BOUNDARY" in evaluate(payload).reasons
    payload = sample()
    payload["completedBarEnd"] -= timedelta(minutes=5)
    assert "INVALID_EVALUATION_BOUNDARY" in evaluate(payload).reasons
    payload = sample()
    model = DiscoveryInput.model_validate(payload)
    assert evaluate_discovery(model, model.evaluation_at + timedelta(seconds=120)).state == "PASS"
    assert evaluate_discovery(model, model.evaluation_at + timedelta(seconds=120, microseconds=1)).state == "DEFERRED"


def test_quote_age_and_future_observations():
    payload = sample()
    payload["quote"]["priceAt"] = payload["evaluationAt"] - timedelta(seconds=30)
    assert evaluate(payload).state == "PASS"
    payload["quote"]["priceAt"] -= timedelta(microseconds=1)
    assert "QUOTE_STALE" in evaluate(payload).reasons
    payload = sample()
    payload["quote"]["observedAt"] = payload["evaluationAt"] + timedelta(seconds=1)
    assert "FUTURE_OBSERVATION" in evaluate(payload).reasons


def test_wilder_seed_then_76_updates_and_prior_close_gap():
    payload = sample()
    # First 14 true ranges are 4; remaining 76 are 2. Closed form is
    # independent of the implementation's recursive loop.
    for bar in payload["dailyBars"][1:15]:
        bar.update(high=52, low=48)
    assert evaluate(payload).metrics.atr14.value == pytest.approx(2 + 2 * (13 / 14) ** 76)
    payload = sample()
    payload["dailyBars"][0].update(open=60, high=61, low=59, close=60, volume=1)
    result = evaluate(payload)
    assert result.metrics.atr14.value == pytest.approx(2 + (9 / 14) * (13 / 14) ** 76)
    assert result.metrics.average_volume90d.value == 2_000_000


def test_numeric_overflow_is_unevaluable_not_infinite_json():
    payload = sample()
    for bar in payload["dailyBars"]:
        bar["volume"] = 1e308
    result = evaluate(payload)
    assert result.state == "UNEVALUABLE"
    assert "INVALID_BAR" in result.reasons
    assert result.metrics.dollar_volume30d.value is None


def test_shared_typescript_fixture_recomputes_exactly():
    import json
    from pathlib import Path

    fixtures = json.loads((Path(__file__).parents[3] / "contracts/fixtures/discovery-evaluation-v1.json").read_text())
    for fixture in fixtures:
        value = DiscoveryInput.model_validate(fixture["input"])
        assert (
            evaluate_discovery(value, value.evaluation_at).model_dump(mode="json", by_alias=True) == fixture["result"]
        )


def test_internal_endpoint_requires_credential_and_keeps_engine_state(monkeypatch):
    import asyncio
    from httpx import ASGITransport, AsyncClient
    from app.config import ScannerConfig
    from app.feature_engine import FeatureEngine
    from app.main import create_app

    engine = FeatureEngine()
    before = deepcopy(engine.__dict__)
    value = DiscoveryInput.model_validate(sample())
    monkeypatch.setattr("app.main.evaluate_discovery", lambda payload: evaluate_discovery(payload, value.evaluation_at))
    app = create_app(ScannerConfig("scanner", "test", "INFO", service_token="fixture-token"), engine)

    async def send():
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            payload = value.model_dump(mode="json", by_alias=True)
            denied = await client.post("/internal/v1/discovery/evaluate", json=payload)
            assert denied.status_code == 401
            accepted = await client.post(
                "/internal/v1/discovery/evaluate", json=payload, headers={"x-scanner-token": "fixture-token"}
            )
            assert accepted.status_code == 200
            assert accepted.json() == evaluate_discovery(value, value.evaluation_at).model_dump(
                mode="json", by_alias=True
            )

    asyncio.run(send())
    # Existing strategy engines are objects without value equality: their data
    # remains untouched, and discovery needs no session initialization.
    assert engine.__dict__.keys() == before.keys()
    for key, content in engine.__dict__.items():
        if isinstance(content, (dict, list, str, int, float, type(None))):
            assert content == before[key]
