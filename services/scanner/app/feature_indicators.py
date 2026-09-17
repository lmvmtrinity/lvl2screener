"""Pure, chronological indicator helpers used by the scanner experiments.

These helpers intentionally return ``None`` while an indicator is warming up.
They never inspect a future suffix, which makes them suitable for live evaluation
and for prefix-invariance tests in the replay engine.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from statistics import fmean
from typing import Literal

from .models import CandleRecord

WILDER_RSI_14_VERSION = "wilder-rsi-14-v1"


@dataclass(frozen=True)
class CandleQuality:
    range: float
    body: float
    lower_wick: float
    upper_wick: float
    close_location: float | None


def candle_quality(candle: CandleRecord) -> CandleQuality:
    """Return wick/body geometry; zero-range candles have unavailable location."""

    candle_range = candle.high - candle.low
    body = abs(candle.close - candle.open)
    lower_wick = min(candle.open, candle.close) - candle.low
    upper_wick = candle.high - max(candle.open, candle.close)
    close_location = None if candle_range <= 0 else (candle.close - candle.low) / candle_range
    return CandleQuality(candle_range, body, lower_wick, upper_wick, close_location)


def is_rejection_candle(
    candle: CandleRecord,
    support: float,
    *,
    lower_wick_body_min: float = 2.0,
    upper_wick_range_max_pct: float = 20.0,
    close_location_min_pct: float = 65.0,
    proximity_pct: float = 0.15,
) -> bool:
    """Classify a possible bullish rejection only when geometry and level agree.

    A doji/zero-body candle is deliberately excluded from the initial hammer
    research definition. Shape alone is not a reversal signal: the low must also
    trade within the configured tolerance of the bound support.
    """

    geometry = candle_quality(candle)
    if geometry.range <= 0 or geometry.body <= 0 or geometry.close_location is None or support <= 0:
        return False
    near_support = (
        candle.low <= support * (1 + proximity_pct / 100)
        and candle.high >= support * (1 - proximity_pct / 100)
    )
    return (
        near_support
        and geometry.lower_wick / geometry.body >= lower_wick_body_min
        and geometry.upper_wick / geometry.range <= upper_wick_range_max_pct / 100
        and geometry.close_location >= close_location_min_pct / 100
    )


def volume_contraction_ratio(
    pullback: list[CandleRecord], impulse: list[CandleRecord]
) -> float | None:
    """Mean pullback volume divided by bound mean impulse volume."""

    if not pullback or not impulse:
        return None
    impulse_mean = fmean(candle.volume for candle in impulse)
    if impulse_mean <= 0:
        return None
    return fmean(candle.volume for candle in pullback) / impulse_mean


def wilder_rsi(closes: list[float], period: int = 14) -> list[float | None]:
    """Return RSI values aligned to close indexes using Wilder smoothing.

    The seed requires ``period`` close-to-close changes. A zero-loss series is
    100, a zero-gain series is 0, and a flat series is 50. Values before the
    seed remain unavailable.
    """

    values: list[float | None] = [None] * len(closes)
    if period <= 0 or len(closes) <= period:
        return values
    changes = [closes[index] - closes[index - 1] for index in range(1, len(closes))]
    gains = [max(change, 0.0) for change in changes]
    losses = [max(-change, 0.0) for change in changes]
    average_gain = fmean(gains[:period])
    average_loss = fmean(losses[:period])

    def finish(gain: float, loss: float) -> float:
        if loss == 0 and gain == 0:
            return 50.0
        if loss == 0:
            return 100.0
        if gain == 0:
            return 0.0
        return 100.0 - 100.0 / (1.0 + gain / loss)

    values[period] = finish(average_gain, average_loss)
    for index in range(period + 1, len(closes)):
        average_gain = ((average_gain * (period - 1)) + gains[index - 1]) / period
        average_loss = ((average_loss * (period - 1)) + losses[index - 1]) / period
        values[index] = finish(average_gain, average_loss)
    return values


def rsi_by_bar(
    bars: list[CandleRecord], period: int = 14
) -> dict[datetime, float]:
    """Map completed bar end timestamps to available Wilder RSI values."""

    ordered = sorted((bar for bar in bars if bar.is_complete), key=lambda bar: bar.end)
    values = wilder_rsi([bar.close for bar in ordered], period)
    return {
        bar.end: value
        for bar, value in zip(ordered, values)
        if value is not None
    }


@dataclass(frozen=True)
class ConfirmedPivotLow:
    pivot_bar: CandleRecord
    confirmation_timestamp: datetime
    rsi: float | None


def confirmed_pivot_lows(
    bars: list[CandleRecord],
    rsi_values: dict[datetime, float],
    *,
    left: int = 2,
    right: int = 2,
) -> list[ConfirmedPivotLow]:
    """Find price pivots whose right-hand confirmation bars are available."""

    if left < 1 or right < 1:
        return []
    ordered = sorted((bar for bar in bars if bar.is_complete), key=lambda bar: bar.end)
    pivots: list[ConfirmedPivotLow] = []
    for index in range(left, len(ordered) - right):
        pivot = ordered[index]
        left_bars = ordered[index - left : index]
        right_bars = ordered[index + 1 : index + right + 1]
        if not all(pivot.low < value.low for value in left_bars):
            continue
        if not all(pivot.low <= value.low for value in right_bars):
            continue
        pivots.append(
            ConfirmedPivotLow(
                pivot_bar=pivot,
                confirmation_timestamp=ordered[index + right].end,
                rsi=rsi_values.get(pivot.end),
            )
        )
    return pivots


@dataclass(frozen=True)
class DailyEMAContext:
    status: Literal["BULLISH", "NEUTRAL", "BEARISH", "UNAVAILABLE"]
    ema13: float | None
    ema21: float | None
    slope13: float | None
    slope21: float | None
    source_timestamp: datetime | None
    reason: str | None


def ema_series(values: list[float], period: int) -> list[float | None]:
    """EMA with an explicit SMA seed at index ``period - 1``."""

    result: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return result
    current = fmean(values[:period])
    result[period - 1] = current
    multiplier = 2 / (period + 1)
    for index in range(period, len(values)):
        current = (values[index] - current) * multiplier + current
        result[index] = current
    return result


def daily_ema_context(daily: list[CandleRecord]) -> DailyEMAContext:
    """Build prior-completed-daily EMA alignment and slopes."""

    ordered = sorted(
        (candle for candle in daily if candle.is_complete), key=lambda candle: candle.end
    )
    source = ordered[-1].end if ordered else None
    closes = [candle.close for candle in ordered]
    ema13 = ema_series(closes, 13)
    ema21 = ema_series(closes, 21)
    ema13_latest = ema13[-1] if ema13 else None
    ema21_latest = ema21[-1] if ema21 else None
    ema13_previous = ema13[-2] if len(ema13) >= 2 else None
    ema21_previous = ema21[-2] if len(ema21) >= 2 else None
    if len(ordered) < 22 or ema13_latest is None or ema21_latest is None or ema13_previous is None or ema21_previous is None:
        return DailyEMAContext("UNAVAILABLE", ema13_latest, ema21_latest, None, None, source, "DAILY_EMA_HISTORY_UNAVAILABLE")
    slope13 = ema13_latest - ema13_previous
    slope21 = ema21_latest - ema21_previous
    latest_close = ordered[-1].close
    if latest_close > ema13_latest and latest_close > ema21_latest and ema13_latest > ema21_latest and slope13 > 0 and slope21 > 0:
        status: Literal["BULLISH", "NEUTRAL", "BEARISH", "UNAVAILABLE"] = "BULLISH"
    elif latest_close < ema13_latest and latest_close < ema21_latest and ema13_latest < ema21_latest and slope13 < 0 and slope21 < 0:
        status = "BEARISH"
    else:
        status = "NEUTRAL"
    return DailyEMAContext(status, ema13_latest, ema21_latest, slope13, slope21, source, None)
