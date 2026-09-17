"""Phase 4 explainable setup scoring.

The score is an explainable quality index, never a probability and never a way
into `READY`. Every point is attributed to exactly one component, and every
component records the feature it read, so the UI can say why a setup scored 78
rather than 68.

`SCORE_VERSION` moves independently from a strategy version and a profile
configuration version: changing a curve or a weight here is a scoring change,
not a strategy change.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:  # pragma: no cover - typing only, keeps models.py importable from here
    from .models import FeatureSnapshot, StrategyParameters, StrategyState
    from .strategies.base import StrategyMemory

SCORE_VERSION = "setup-score-v1"

ScoreGroup = Literal["pattern", "confirmation", "structure", "liquidity", "timing", "penalties"]
SCORE_GROUPS: tuple[ScoreGroup, ...] = ("pattern", "confirmation", "structure", "liquidity", "timing", "penalties")
GROUP_MAXIMUM: dict[ScoreGroup, int] = {"pattern": 25, "confirmation": 20, "structure": 20, "liquidity": 20, "timing": 15, "penalties": 0}
PENALTY_FLOOR = -40
# States that cannot be traded keep a hard score ceiling so no ranking view ever
# reads them as a near-ready opportunity.
NON_TRADEABLE_STATES: tuple[str, ...] = ("INACTIVE", "INVALIDATED", "EXPIRED", "HALTED", "DATA_STALE")
NON_TRADEABLE_SCORE_CAP = 59

# Mirrors SPREAD_PREFERRED_MAX_PCT in @tsx-scanner/contracts.
SPREAD_PREFERRED_MAX_PCT = 0.15

# Phase 2.5: one scoring owner per shared feature. A feature listed here must not
# also be rewarded by a strategy-owned pattern or confirmation rule.
SHARED_FEATURE_OWNERS: dict[str, ScoreGroup] = {
    "spread_pct": "liquidity",
    "rvol_at_time": "liquidity",
    "atr_pct": "liquidity",
    "risk_distance_atr": "structure",
    "estimated_rr": "structure",
    "distance_from_vwap_atr": "structure",
    "entry_window": "timing",
    "setup_age_minutes": "timing",
    "data_status": "penalties",
    "warming_up": "penalties",
}


@dataclass(frozen=True)
class ScoreRule:
    """A strategy-owned point award keyed to one reason code it emits."""

    reason: str
    group: Literal["pattern", "confirmation"]
    points: int
    label: str


@dataclass(frozen=True)
class ScoreContribution:
    key: str
    group: ScoreGroup
    label: str
    points: int
    maximum: int
    value: float | None
    detail: str


@dataclass(frozen=True)
class SetupScore:
    version: str
    total: int
    components: dict[str, int]
    contributions: list[ScoreContribution]


def saturating(value: float, knee: float, maximum: int) -> int:
    """Diminishing-returns curve for unbounded features: `value == knee` earns half."""
    if value <= 0 or knee <= 0:
        return 0
    return round(maximum * value / (value + knee))


def _strategy_contributions(rules: tuple[ScoreRule, ...], reasons: list[str]) -> list[ScoreContribution]:
    present = set(reasons)
    return [ScoreContribution(key=rule.reason, group=rule.group, label=rule.label, points=rule.points,
                              maximum=rule.points, value=None, detail="Observed in this evaluation")
            for rule in rules if rule.reason in present]


def _liquidity_contributions(f: FeatureSnapshot, parameters: StrategyParameters) -> list[ScoreContribution]:
    hard_max = max(parameters.spread_hard_max_pct, SPREAD_PREFERRED_MAX_PCT)
    if f.spread_pct <= SPREAD_PREFERRED_MAX_PCT:
        spread_points, spread_detail = 8, f"Spread {f.spread_pct:.3f}% is at or below the preferred {SPREAD_PREFERRED_MAX_PCT}%"
    else:
        span = hard_max - SPREAD_PREFERRED_MAX_PCT
        remaining = 0.0 if span <= 0 else max(0.0, (hard_max - f.spread_pct) / span)
        spread_points = round(8 * remaining)
        spread_detail = f"Spread {f.spread_pct:.3f}% sits between the preferred {SPREAD_PREFERRED_MAX_PCT}% and the hard reject {hard_max}%"
    rvol = f.rvol_at_time or 0
    atr = f.atr_pct or 0
    return [
        ScoreContribution("SPREAD_QUALITY", "liquidity", "Spread quality", spread_points, 8, f.spread_pct, spread_detail),
        ScoreContribution("RELATIVE_VOLUME", "liquidity", "Relative volume", saturating(rvol, 1.5, 8), 8, f.rvol_at_time,
                          f"Saturating curve on RVOL {rvol:.2f}×; 1.50× earns half the available points"),
        ScoreContribution("RANGE_AVAILABLE", "liquidity", "Range available", saturating(atr, 1.5, 4), 4, f.atr_pct,
                          f"Saturating curve on ATR {atr:.2f}% of price; 1.50% earns half the available points"),
    ]


def _structure_contributions(f: FeatureSnapshot, entry: float | None, stop: float | None, rr: float | None) -> list[ScoreContribution]:
    risk_atr = None
    if entry is not None and stop is not None and f.atr_14:
        risk_atr = (entry - stop) / f.atr_14
    if risk_atr is None:
        invalidation = ScoreContribution("DISTANCE_TO_INVALIDATION", "structure", "Distance to invalidation", 0, 8, None,
                                         "No structural invalidation level is known yet")
    elif risk_atr <= 0:
        invalidation = ScoreContribution("DISTANCE_TO_INVALIDATION", "structure", "Distance to invalidation", 0, 8, risk_atr,
                                         "Invalidation is at or above the entry reference, so the geometry is invalid")
    elif 0.15 <= risk_atr <= 1:
        invalidation = ScoreContribution("DISTANCE_TO_INVALIDATION", "structure", "Distance to invalidation", 8, 8, risk_atr,
                                         f"Invalidation is {risk_atr:.2f} ATR away: close enough to define risk, far enough to survive noise")
    elif risk_atr < 0.15:
        invalidation = ScoreContribution("DISTANCE_TO_INVALIDATION", "structure", "Distance to invalidation", 3, 8, risk_atr,
                                         f"Invalidation is only {risk_atr:.2f} ATR away and is likely to be hit by noise")
    else:
        invalidation = ScoreContribution("DISTANCE_TO_INVALIDATION", "structure", "Distance to invalidation", 3 if risk_atr <= 1.5 else 0, 8, risk_atr,
                                         f"Invalidation is {risk_atr:.2f} ATR away, which makes the risk per share large")
    if rr is None:
        reward = ScoreContribution("RISK_REWARD_VALIDITY", "structure", "Risk/reward validity", 0, 8, None,
                                   "No complete entry, stop, and target geometry yet")
    else:
        points = 8 if rr >= 2 else 6 if rr >= 1.5 else 3 if rr >= 1 else 0
        reward = ScoreContribution("RISK_REWARD_VALIDITY", "structure", "Risk/reward validity", points, 8, rr,
                                   f"Estimated reward/risk {rr:.2f} against the nearest structural target")
    extension = f.distance_from_vwap_atr
    if extension is None:
        vwap = ScoreContribution("VWAP_EXTENSION", "structure", "Extension from VWAP", 0, 4, None, "VWAP distance is unavailable")
    else:
        points = 4 if extension <= 0.75 else 2 if extension <= 1.25 else 0
        vwap = ScoreContribution("VWAP_EXTENSION", "structure", "Extension from VWAP", points, 4, extension,
                                 f"Price is {extension:.2f} ATR from VWAP; entries far above VWAP pay a worse price")
    return [invalidation, reward, vwap]


ENTRY_WINDOW_POINTS: dict[str, tuple[int, str]] = {
    "PREFERRED_ENTRY_WINDOW": (8, "Inside the preferred entry window"),
    "WAITING_FOR_PREFERRED_ENTRY_WINDOW": (4, "Before the preferred entry window opens"),
    "OUTSIDE_PREFERRED_ENTRY_WINDOW": (2, "After the preferred entry window closes"),
    "NEW_ENTRY_WINDOW_CLOSED": (0, "The hard entry window is closed"),
    "SCANNING_WINDOW_NOT_OPEN": (0, "The scanning window has not opened"),
}


def _timing_contributions(f: FeatureSnapshot, reasons: list[str], memory: StrategyMemory, parameters: StrategyParameters) -> list[ScoreContribution]:
    window = next(((points, detail) for reason, (points, detail) in ENTRY_WINDOW_POINTS.items() if reason in reasons), None)
    session = ScoreContribution("TIME_OF_DAY", "timing", "Time of day", window[0] if window else 4, 8, None,
                                window[1] if window else "No session window is configured; scored neutral")
    origin = memory.breakout_at or memory.pullback_at
    if origin is None:
        freshness = ScoreContribution("SETUP_FRESHNESS", "timing", "Setup freshness", 0, 7, None, "No formation has armed yet")
    else:
        age = (f.timestamp - origin) / timedelta(minutes=1)
        remaining = max(0.0, 1 - age / max(parameters.setup_timeout_minutes, 1))
        freshness = ScoreContribution("SETUP_FRESHNESS", "timing", "Setup freshness", round(7 * remaining), 7, age,
                                      f"Formation armed {age:.0f} min ago against a {parameters.setup_timeout_minutes} min timeout")
    return [session, freshness]


def _penalty_contributions(f: FeatureSnapshot) -> list[ScoreContribution]:
    contributions: list[ScoreContribution] = []
    if f.data_status == "HALTED":
        contributions.append(ScoreContribution("HALTED", "penalties", "Halted instrument", -40, 0, None, "The instrument is halted"))
    elif f.data_status != "REALTIME" or not f.actionable:
        contributions.append(ScoreContribution("DATA_NOT_ACTIONABLE", "penalties", "Data not actionable", -25, 0, None,
                                               f"Data status {f.data_status} is not actionable for entries"))
    if f.warming_up:
        contributions.append(ScoreContribution("FEATURES_WARMING_UP", "penalties", "Features warming up", -10, 0, None,
                                               f"Still warming up: {', '.join(f.warming_up)}"))
    return contributions


def score_setup(rules: tuple[ScoreRule, ...], f: FeatureSnapshot, parameters: StrategyParameters, memory: StrategyMemory,
                state: StrategyState, reasons: list[str], entry: float | None, stop: float | None, rr: float | None) -> SetupScore:
    contributions = [
        *_strategy_contributions(rules, reasons),
        *_structure_contributions(f, entry, stop, rr),
        *_liquidity_contributions(f, parameters),
        *_timing_contributions(f, reasons, memory, parameters),
        *_penalty_contributions(f),
    ]
    components = {group: 0 for group in SCORE_GROUPS}
    for contribution in contributions:
        components[contribution.group] += contribution.points
    for group in ("pattern", "confirmation", "structure", "liquidity", "timing"):
        components[group] = max(0, min(GROUP_MAXIMUM[group], components[group]))
    components["penalties"] = max(PENALTY_FLOOR, components["penalties"])

    total = sum(components.values())
    capped = max(0, min(100, total))
    if state in NON_TRADEABLE_STATES:
        capped = min(capped, NON_TRADEABLE_SCORE_CAP)
    if capped != total:
        contributions.append(ScoreContribution("SCORE_BOUND", "penalties", "Score bound applied", capped - total, 0, None,
                                               f"Bounded from {total} to {capped}" + (f" because state {state} cannot be traded" if state in NON_TRADEABLE_STATES else "")))
        components["penalties"] += capped - total
    ordered = sorted(contributions, key=lambda value: (SCORE_GROUPS.index(value.group), value.key))
    return SetupScore(version=SCORE_VERSION, total=capped, components={group: components[group] for group in SCORE_GROUPS}, contributions=ordered)
