"""Stateless discovery contracts; no shared strategy state or indicator mutation."""

from datetime import date
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Market = Literal["CA_TSX", "US_EQUITIES"]
Source = Literal["QUESTRADE", "FIXTURE"]


class DiscoveryModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid", allow_inf_nan=False)


class Identity(DiscoveryModel):
    market_id: Market
    symbol_id: int = Field(gt=0)
    symbol: str
    exchange: str
    currency: Literal["CAD", "USD"]
    classification: Literal["COMMON_STOCK_REVIEWED", "OTHER", "UNKNOWN"]
    observed_at: AwareDatetime
    source: Source


class Capitalization(DiscoveryModel):
    value: float | None
    currency: Literal["CAD", "USD"]
    observed_at: AwareDatetime
    source: Source


class DiscoveryQuote(DiscoveryModel):
    price: float | None
    open: float | None
    price_at: AwareDatetime | None
    observed_at: AwareDatetime
    delayed: bool | None
    halted: bool | None
    session: Literal["REGULAR", "EXTENDED", "UNKNOWN"]
    source: Source


class CalendarSession(DiscoveryModel):
    trading_date: date
    open: AwareDatetime
    close: AwareDatetime


class CalendarEvidence(DiscoveryModel):
    market_id: Market
    verified: bool
    revision: str = Field(min_length=1)
    source: str = Field(min_length=1)
    observed_at: AwareDatetime
    sessions: list[CalendarSession] = Field(max_length=400)


class AdjustmentEvidence(DiscoveryModel):
    verified: bool
    revision: str = Field(min_length=1)
    source: str = Field(min_length=1)
    convention: Literal["UNADJUSTED", "SPLIT_ADJUSTED", "UNKNOWN"]
    has_unresolved_corporate_action: bool
    observed_at: AwareDatetime


class HistoryValues(DiscoveryModel):
    open: float
    high: float
    low: float
    close: float
    volume: float
    observed_at: AwareDatetime
    complete: bool
    source: Source
    adjustment_revision: str = Field(min_length=1)


class DailyBar(HistoryValues):
    trading_date: date


class SlotBar(HistoryValues):
    start: AwareDatetime
    end: AwareDatetime


class DiscoveryInput(DiscoveryModel):
    market_id: Market
    policy_version: Literal["ca-discovery-v1", "us-discovery-v1"]
    provider_code: str = Field(min_length=1, max_length=100)
    provider_exchange: str = Field(min_length=1, max_length=100)
    trading_date: date
    evaluation_at: AwareDatetime
    completed_bar_end: AwareDatetime
    identity: Identity
    market_cap: Capitalization
    quote: DiscoveryQuote | None
    calendar: CalendarEvidence
    adjustment: AdjustmentEvidence
    daily_bars: list[DailyBar] = Field(max_length=400)
    slot_bars: list[SlotBar] = Field(max_length=2000)


class Metric(DiscoveryModel):
    value: float | None = None
    as_of: AwareDatetime | None = None


class DiscoveryMetrics(DiscoveryModel):
    price: Metric = Field(default_factory=Metric)
    market_cap: Metric = Field(default_factory=Metric)
    average_volume90d: Metric = Field(default_factory=Metric, alias="averageVolume90d")
    average_volume30d: Metric = Field(default_factory=Metric, alias="averageVolume30d")
    atr14: Metric = Field(default_factory=Metric)
    atr_pct: Metric = Field(default_factory=Metric)
    relative_volume: Metric = Field(default_factory=Metric)
    change_from_open_pct: Metric = Field(default_factory=Metric)
    dollar_volume30d: Metric = Field(default_factory=Metric, alias="dollarVolume30d")


class DiscoveryResult(DiscoveryModel):
    market_id: Market
    policy_version: Literal["ca-discovery-v1", "us-discovery-v1"]
    provider_code: str
    provider_exchange: str
    symbol_id: int | None
    trading_date: date
    evaluation_at: AwareDatetime
    computed_at: AwareDatetime
    completed_bar_end: AwareDatetime
    state: Literal["PASS", "FAIL", "UNEVALUABLE", "DEFERRED"]
    reasons: list[str]
    metrics: DiscoveryMetrics
