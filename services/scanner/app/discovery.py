"""Independent completed-bar discovery analytics. These are not strategy signals."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal, localcontext
from math import isfinite
from zoneinfo import ZoneInfo

from .discovery_models import (
    CalendarSession,
    DailyBar,
    DiscoveryInput,
    DiscoveryMetrics,
    DiscoveryResult,
    HistoryValues,
    Metric,
)

THRESHOLDS = {
    "CA_TSX": (5.0, 150.0, 400_000_000.0, 400_000.0, 1.5, 1.5, 0.75, 15_000_000.0),
    "US_EQUITIES": (10.0, 200.0, 1_000_000_000.0, 1_000_000.0, 2.0, 1.75, 1.0, 50_000_000.0),
}
PROVIDER_EXCHANGE_EQUIVALENTS = {
    "CA_TSX": {"TSX": {"TO", "TSX"}},
    "US_EQUITIES": {"NASDAQ": {"XNAS", "NASDAQ"}, "NYSE": {"XNYS", "NYSE"}},
}
FIVE_MINUTES = timedelta(minutes=5)


def evaluate_discovery(value: DiscoveryInput, now: datetime | None = None) -> DiscoveryResult:
    with localcontext() as context:
        context.prec = 50
        return _evaluate_discovery(value, now)


def _evaluate_discovery(value: DiscoveryInput, now: datetime | None = None) -> DiscoveryResult:
    computed_at = now or datetime.now(UTC)
    at = value.evaluation_at
    reasons: list[str] = []
    failures: list[str] = []
    metrics = DiscoveryMetrics()
    precise: dict[str, Decimal] = {}

    def decimal(number: float) -> Decimal:
        return Decimal(str(number))

    def publish(field: str, number: Decimal, timestamp: datetime) -> None:
        # Comparison uses the unrounded decimal; float conversion is for JSON only.
        encoded = float(number)
        if not isfinite(encoded):
            reasons.append("INVALID_BAR")
            return
        precise[field] = number
        setattr(metrics, field, Metric(value=encoded, as_of=timestamp))

    expected_version = "ca-discovery-v1" if value.market_id == "CA_TSX" else "us-discovery-v1"

    def result(state: str) -> DiscoveryResult:
        return DiscoveryResult.model_validate(
            {
                "marketId": value.market_id,
                "policyVersion": expected_version,
                "providerCode": value.provider_code,
                "symbolId": value.identity.symbol_id,
                "providerExchange": value.provider_exchange,
                "tradingDate": value.trading_date,
                "evaluationAt": at,
                "computedAt": computed_at,
                "completedBarEnd": value.completed_bar_end,
                "state": state,
                "reasons": list(dict.fromkeys(reasons + failures)),
                "metrics": metrics,
            }
        )

    if at > computed_at:
        reasons.append("FUTURE_OBSERVATION")
        return result("UNEVALUABLE")
    if computed_at - at > timedelta(seconds=120):
        reasons.append("EVALUATION_EXPIRED")
        return result("DEFERRED")
    currency = "CAD" if value.market_id == "CA_TSX" else "USD"
    exchanges = {"TSX"} if value.market_id == "CA_TSX" else {"NYSE", "NASDAQ"}
    if (
        value.identity.market_id != value.market_id
        or value.calendar.market_id != value.market_id
        or value.policy_version != expected_version
    ):
        reasons.append("MARKET_MISMATCH")
    if value.identity.exchange not in exchanges:
        reasons.append("EXCHANGE_NOT_ALLOWED")
    expected_symbol = f"{value.provider_code}.TO" if value.market_id == "CA_TSX" else value.provider_code
    provider_exchange = value.provider_exchange.strip().upper()
    accepted_provider_exchanges = PROVIDER_EXCHANGE_EQUIVALENTS[value.market_id].get(value.identity.exchange, set())
    if value.identity.symbol != expected_symbol or provider_exchange not in accepted_provider_exchanges:
        reasons.append("MAPPING_UNAVAILABLE")
    if value.identity.currency != currency or value.market_cap.currency != currency:
        reasons.append("CURRENCY_NOT_ALLOWED")
    if value.identity.classification != "COMMON_STOCK_REVIEWED":
        reasons.append("CLASSIFICATION_REVIEW_REQUIRED")
    observations = [
        value.identity.observed_at,
        value.market_cap.observed_at,
        value.calendar.observed_at,
        value.adjustment.observed_at,
    ]
    if any(timestamp > at for timestamp in observations):
        reasons.append("FUTURE_OBSERVATION")
    if value.market_cap.source != value.identity.source:
        reasons.append("METADATA_UNAVAILABLE")
    if value.market_cap.value is None or value.market_cap.value < 0:
        reasons.append("METADATA_UNAVAILABLE")
    elif value.market_cap.observed_at <= at:
        publish("market_cap", decimal(value.market_cap.value), value.market_cap.observed_at)
    adjustment_ok = (
        value.adjustment.verified
        and value.adjustment.convention != "UNKNOWN"
        and not value.adjustment.has_unresolved_corporate_action
    )
    if not adjustment_ok:
        reasons.append("ADJUSTMENT_UNVERIFIED")

    timezone = ZoneInfo("America/Toronto" if value.market_id == "CA_TSX" else "America/New_York")
    sessions = sorted(value.calendar.sessions, key=lambda session: session.open)
    dates = [session.trading_date for session in sessions]
    calendar_ok = value.calendar.verified and len(set(dates)) == len(dates)
    for index, session in enumerate(sessions):
        if (
            session.open >= session.close
            or session.open.astimezone(timezone).date() != session.trading_date
            or session.close.astimezone(timezone).date() != session.trading_date
        ):
            calendar_ok = False
        if index and sessions[index - 1].close >= session.open:
            calendar_ok = False
    current = next((session for session in sessions if session.trading_date == value.trading_date), None)
    prior = [session for session in sessions if session.trading_date < value.trading_date][-91:]
    if not calendar_ok or current is None:
        reasons.append("CALENDAR_UNVERIFIED")
    boundary_ok = False
    if current is not None:
        if not current.open <= at < current.close:
            reasons.append("OUTSIDE_REGULAR_SESSION")
        elapsed = (value.completed_bar_end - current.open).total_seconds()
        latest_end = current.open + timedelta(seconds=int((at - current.open).total_seconds() // 300) * 300)
        boundary_ok = (
            elapsed >= 300
            and elapsed % 300 == 0
            and value.completed_bar_end <= current.close
            and at >= value.completed_bar_end + timedelta(seconds=15)
            and latest_end == value.completed_bar_end
        )
        if not boundary_ok:
            reasons.append("INVALID_EVALUATION_BOUNDARY")

    quote = value.quote
    if quote is None:
        reasons.append("QUOTE_UNAVAILABLE")
    else:
        quote_reasons: list[str] = []
        if quote.delayed is None or quote.halted is None or quote.source != value.identity.source:
            quote_reasons.append("QUOTE_UNAVAILABLE")
        if quote.delayed:
            quote_reasons.append("QUOTE_DELAYED")
        if quote.halted:
            quote_reasons.append("QUOTE_HALTED")
        if quote.session != "REGULAR" or (
            current and quote.price_at and not current.open <= quote.price_at < current.close
        ):
            quote_reasons.append("OUTSIDE_REGULAR_SESSION")
        if quote.observed_at > at or (quote.price_at and (quote.price_at > at or quote.price_at > quote.observed_at)):
            quote_reasons.append("FUTURE_OBSERVATION")
        if (
            quote.price_at is None
            or at - quote.observed_at > timedelta(seconds=30)
            or (quote.price_at and at - quote.price_at > timedelta(seconds=30))
        ):
            quote_reasons.append("QUOTE_STALE")
        if quote.price is None or quote.price <= 0:
            quote_reasons.append("QUOTE_UNAVAILABLE")
        if quote.open is None or quote.open <= 0:
            quote_reasons.append("INVALID_OPEN")
        reasons.extend(quote_reasons)
        if not quote_reasons and quote.price is not None and quote.open is not None:
            publish("price", decimal(quote.price), quote.observed_at)
            publish(
                "change_from_open_pct",
                100 * (decimal(quote.price) - decimal(quote.open)) / decimal(quote.open),
                quote.observed_at,
            )

    def valid_bar(bar: HistoryValues, end: datetime) -> bool:
        valid = True
        if not bar.complete or bar.observed_at < end:
            reasons.append("INVALID_BAR")
            valid = False
        if bar.observed_at > at or end > at:
            reasons.append("FUTURE_OBSERVATION")
            valid = False
        if (
            min(bar.open, bar.high, bar.low, bar.close) <= 0
            or bar.volume < 0
            or not (bar.low <= min(bar.open, bar.close) <= max(bar.open, bar.close) <= bar.high)
        ):
            reasons.append("INVALID_BAR")
            valid = False
        if (
            bar.source != value.identity.source
            or bar.adjustment_revision != value.adjustment.revision
            or not adjustment_ok
        ):
            reasons.append("ADJUSTMENT_UNVERIFIED")
            valid = False
        return valid

    history: list[DailyBar] = []
    if calendar_ok and len(prior) == 91:
        for session in prior:
            bars = [bar for bar in value.daily_bars if bar.trading_date == session.trading_date]
            if len(bars) > 1:
                reasons.append("DUPLICATE_BAR")
            if len(bars) != 1 or not bars[0].complete:
                continue
            if valid_bar(bars[0], session.close):
                history.append(bars[0])
    if len(history) != 91:
        reasons.append("INSUFFICIENT_DAILY_HISTORY")
    else:
        history_at = max(bar.observed_at for bar in history)
        publish("average_volume90d", sum((decimal(bar.volume) for bar in history[-90:]), Decimal(0)) / 90, history_at)
        publish("average_volume30d", sum((decimal(bar.volume) for bar in history[-30:]), Decimal(0)) / 30, history_at)
        ranges = [
            max(
                decimal(bar.high) - decimal(bar.low),
                abs(decimal(bar.high) - decimal(history[index - 1].close)),
                abs(decimal(bar.low) - decimal(history[index - 1].close)),
            )
            for index, bar in enumerate(history)
            if index > 0
        ]
        atr = sum(ranges[:14], Decimal(0)) / 14
        for true_range in ranges[14:]:
            atr = (atr * 13 + true_range) / 14
        publish("atr14", atr, history_at)
        if metrics.price.value is not None:
            combined_at = max(history_at, metrics.price.as_of or at)
            publish("atr_pct", 100 * atr / precise["price"], combined_at)
            if "average_volume30d" in precise:
                publish("dollar_volume30d", precise["price"] * precise["average_volume30d"], combined_at)

    if current and calendar_ok and boundary_ok and len(prior) >= 10:
        offset = value.completed_bar_end - current.open
        slot_sessions: list[CalendarSession] = prior[-10:] + [current]
        volumes: list[float] = []
        available_at: list[datetime] = []
        for session in slot_sessions:
            end = session.open + offset
            start = end - FIVE_MINUTES
            slot_bars = [bar for bar in value.slot_bars if bar.start == start]
            if len(slot_bars) > 1:
                reasons.append("DUPLICATE_BAR")
            if end > session.close or len(slot_bars) != 1:
                continue
            slot_bar = slot_bars[0]
            if slot_bar.end != end:
                reasons.append("INVALID_BAR")
                continue
            if valid_bar(slot_bar, end):
                volumes.append(slot_bar.volume)
                available_at.append(slot_bar.observed_at)
        if len(volumes) == 11:
            denominator = sum((decimal(volume) for volume in volumes[:10]), Decimal(0)) / 10
            if denominator <= 0:
                reasons.append("ZERO_SLOT_BASELINE")
            else:
                publish("relative_volume", decimal(volumes[-1]) / denominator, max(available_at))
        else:
            reasons.append("INSUFFICIENT_SLOT_HISTORY")
    else:
        reasons.append("INSUFFICIENT_SLOT_HISTORY")

    minimum, maximum, cap, volume, atr_pct, relative, change, dollars = THRESHOLDS[value.market_id]
    if metrics.price.value is not None and not minimum <= metrics.price.value <= maximum:
        failures.append("PRICE_OUT_OF_RANGE")
    for field, threshold, reason in [
        ("market_cap", cap, "MARKET_CAP_THRESHOLD"),
        ("average_volume90d", volume, "AVERAGE_VOLUME_THRESHOLD"),
        ("atr_pct", atr_pct, "ATR_THRESHOLD"),
        ("relative_volume", relative, "RELATIVE_VOLUME_THRESHOLD"),
        ("change_from_open_pct", change, "CHANGE_FROM_OPEN_THRESHOLD"),
        ("dollar_volume30d", dollars, "DOLLAR_VOLUME_THRESHOLD"),
    ]:
        if field in precise and precise[field] <= decimal(threshold):
            failures.append(reason)
    return result("UNEVALUABLE" if reasons else "FAIL" if failures else "PASS")
