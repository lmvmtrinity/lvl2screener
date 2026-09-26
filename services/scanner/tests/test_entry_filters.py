from datetime import timedelta
from dataclasses import replace
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.models import ScannerProfileConfig, StrategyParameters
from app.strategies.base import BenchmarkObservation, StrategyContext
from app.strategy_engine import StrategyEngine
from test_feature_engine import quote, session, warmed_engine
from test_phase5_orb_hardening import _orb_bars


def _engine(strategy="PRIOR_DAY_HIGH_BREAKOUT", **parameters):
    engine = StrategyEngine()
    engine.start_session(session())
    engine.configure_profiles([ScannerProfileConfig(
        profile_id=UUID("10000000-0000-4000-8000-0000000000e1"),
        profile_name="Entry filter", strategy=strategy, config_version="entry-test",
        parameters=StrategyParameters.model_validate(parameters),
    )])
    return engine


def _input():
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    base, breakout, _ = _orb_bars(snapshot.opening_range.high)
    snapshot = snapshot.model_copy(update={
        "timestamp": breakout.end, "price": breakout.close,
        "distance_from_vwap_atr": 0.4, "change_from_open_atr": 1.2,
    })
    return snapshot, StrategyContext(bars=[*base, breakout], prior_day_high=snapshot.opening_range.high)


def _evaluate(engine, snapshot, context):
    return engine.evaluate(snapshot, context)[0][0]


@pytest.mark.parametrize("key,field,limit", [
    ("maxVwapDistanceAtr", "distance_from_vwap_atr", 0.4),
    ("maxChangeFromOpenAtr", "change_from_open_atr", 1.2),
])
@pytest.mark.parametrize("strategy", ["PRIOR_DAY_HIGH_BREAKOUT", "HIGH_OF_DAY_BREAKOUT"])
def test_extension_caps_only_block_new_ready_above_limit(key, field, limit, strategy):
    snapshot, context = _input()
    engine = _engine(strategy, **{key: limit})
    blocked = _evaluate(engine, snapshot.model_copy(update={field: limit + .001}), context)
    assert blocked.state == "FORMING"
    assert "OVEREXTENDED_ENTRY" in blocked.reason_codes
    ready = _evaluate(engine, snapshot.model_copy(update={field: limit}), context)
    assert ready.state == "READY"
    still_ready = _evaluate(engine, snapshot.model_copy(update={field: limit + 1}), context)
    assert still_ready.state == "READY"
    assert "OVEREXTENDED_ENTRY" not in still_ready.reason_codes


def test_defaults_preserve_ready_and_trade_references():
    snapshot, context = _input()
    baseline = _evaluate(_engine(), snapshot, context)
    disabled = _evaluate(_engine(latestReadyTime=None, maxVwapDistanceAtr=0, maxChangeFromOpenAtr=0,
                                 minSectorRelativeStrengthPct=0), snapshot, context)
    assert baseline.model_dump() == disabled.model_dump()
    assert baseline.state == "READY"


@pytest.mark.parametrize("minute,expected", [(14 * 60 + 59, "READY"), (15 * 60, "FORMING"), (15 * 60 + 1, "FORMING")])
def test_latest_ready_uses_market_local_clock(minute, expected):
    snapshot, context = _input()
    snapshot = snapshot.model_copy(update={"timestamp": snapshot.timestamp.replace(hour=minute // 60 + 4, minute=minute % 60)})
    value = _evaluate(_engine(latestReadyTime="15:00"), snapshot, context)
    assert value.state == expected
    assert ("READY_WINDOW_CLOSED" in value.reason_codes) == (expected == "FORMING")


def test_cutoff_does_not_demote_existing_ready():
    snapshot, context = _input()
    snapshot = snapshot.model_copy(update={"timestamp": snapshot.timestamp.replace(hour=18, minute=59)})
    shift = snapshot.timestamp - context.bars[-1].end
    context = replace(context, bars=[bar.model_copy(update={"start": bar.start + shift, "end": bar.end + shift}) for bar in context.bars])
    engine = _engine(latestReadyTime="15:00")
    first = _evaluate(engine, snapshot, context)
    later = _evaluate(engine, snapshot.model_copy(update={"timestamp": snapshot.timestamp + timedelta(minutes=1)}), context)
    assert first.state == later.state == "READY"
    assert (first.entry_reference, first.stop_reference, first.target_reference) == (later.entry_reference, later.stop_reference, later.target_reference)


@pytest.mark.parametrize("value", ["24:00", "15:60", "9:00", "garbage"])
def test_invalid_ready_clock_rejected(value):
    with pytest.raises(ValidationError):
        StrategyParameters.model_validate({"latestReadyTime": value})


def _vwap_input():
    snapshot, context = _input()
    # The entry filter is tested at the READY boundary independently of VWAP formation.
    benchmark = BenchmarkObservation("XIC.TO", 1.0, snapshot.timestamp, "REALTIME", True)
    return snapshot.model_copy(update={"change_from_open_pct": 3.5}), replace(context, sector_benchmark=benchmark)


@pytest.mark.parametrize("delta,expected", [(2.499, "FORMING"), (2.5, "READY"), (2.501, "READY")])
def test_sector_floor_boundary(delta, expected):
    snapshot, context = _vwap_input()
    snapshot = snapshot.model_copy(update={"change_from_open_pct": 1 + delta})
    engine = _engine("VWAP_HOLD", minSectorRelativeStrengthPct=2.5)
    profile = engine._profiles[0]
    state, _ = engine._apply_entry_filters("READY", [], "FORMING", snapshot, context, profile)
    assert state == expected


@pytest.mark.parametrize("kind", ["missing", "future", "stale", "halted", "nonactionable", "no_return"])
def test_sector_unavailable_blocks_only_new_ready(kind):
    snapshot, context = _vwap_input()
    benchmark = context.sector_benchmark
    if kind == "missing":
        benchmark = None
    elif kind == "future":
        benchmark = replace(benchmark, timestamp=snapshot.timestamp + timedelta(seconds=1))
    elif kind == "stale":
        benchmark = replace(benchmark, timestamp=snapshot.timestamp - timedelta(seconds=31))
    elif kind == "halted":
        benchmark = replace(benchmark, data_status="HALTED")
    elif kind == "nonactionable":
        benchmark = replace(benchmark, actionable=False)
    else:
        benchmark = replace(benchmark, change_from_open_pct=None)
    context = replace(context, sector_benchmark=benchmark)
    engine = _engine("VWAP_HOLD", minSectorRelativeStrengthPct=2.5)
    profile = engine._profiles[0]
    state, reasons = engine._apply_entry_filters("READY", [], "FORMING", snapshot, context, profile)
    assert state == "FORMING"
    assert "SECTOR_ENTRY_UNAVAILABLE" in reasons
    assert engine._apply_entry_filters("READY", [], "READY", snapshot, context, profile) == ("READY", [])


def test_extension_gate_does_not_apply_to_orb():
    snapshot, context = _input()
    engine = _engine("ORB_RETEST", maxVwapDistanceAtr=.01, maxChangeFromOpenAtr=.01)
    assert engine._apply_entry_filters("READY", [], "FORMING", snapshot, context, engine._profiles[0]) == ("READY", [])


@pytest.mark.parametrize("value", [None, float("nan"), float("inf")])
def test_enabled_extension_waits_for_finite_feature(value):
    snapshot, context = _input()
    result = _evaluate(_engine(maxVwapDistanceAtr=.4), snapshot.model_copy(update={"distance_from_vwap_atr": value}), context)
    assert result.state == "FORMING"
    assert "ENTRY_EXTENSION_UNAVAILABLE" in result.reason_codes


@pytest.mark.parametrize("month,utc_hour", [(8, 19), (12, 20)])
def test_ready_cutoff_tracks_daylight_saving(month, utc_hour):
    snapshot, context = _input()
    snapshot = snapshot.model_copy(update={"timestamp": snapshot.timestamp.replace(month=month, hour=utc_hour, minute=0)})
    engine = _engine(latestReadyTime="15:00")
    assert engine._apply_entry_filters("READY", [], "FORMING", snapshot, context, engine._profiles[0]) == ("FORMING", ["READY_WINDOW_CLOSED"])


def test_diagnostics_count_repeated_attempts_separately_from_formations():
    snapshot, context = _input()
    engine = _engine(maxVwapDistanceAtr=.3)
    engine._collect_entry_filter_diagnostics = True
    for _ in range(3):
        assert _evaluate(engine, snapshot, context).state == "FORMING"
    assert engine.entry_filter_diagnostics == {"PRIOR_DAY_HIGH_BREAKOUT": {"OVEREXTENDED_ENTRY": {"blockedEvaluations": 3, "blockedInstances": 1}}}
    engine.reset()
    assert engine.entry_filter_diagnostics == {}


def test_sector_gate_runs_through_real_vwap_formation_and_can_release_later():
    from test_strategy_engine import bar

    snapshot, context = _vwap_input()
    touch = bar(6, 100.1, 100.3, 99.95, 100.2, 100)
    hold = bar(7, 100.2, 100.6, 100.1, 100.5, 120)
    snapshot = snapshot.model_copy(update={"vwap": 100, "completed_bar_vwap": 100,
                                          "last_3_closes_above_vwap": 3, "timestamp": touch.end})
    engine = _engine("VWAP_HOLD", minSectorRelativeStrengthPct=2.5)
    assert _evaluate(engine, snapshot, replace(context, bars=[touch])).state == "FORMING"
    snapshot = snapshot.model_copy(update={"timestamp": hold.end})
    future = replace(context.sector_benchmark, timestamp=hold.end + timedelta(seconds=1))
    assert _evaluate(engine, snapshot, replace(context, bars=[touch, hold], sector_benchmark=future)).state == "FORMING"
    current = replace(future, timestamp=hold.end)
    assert _evaluate(engine, snapshot, replace(context, bars=[touch, hold], sector_benchmark=current)).state == "READY"
    assert _evaluate(engine, snapshot, replace(context, bars=[touch, hold], sector_benchmark=None)).state == "READY"


def test_replay_returns_blocked_diagnostics_even_without_ready_events():
    from app.backtest import replay
    from app.models import BacktestReplayRequest, BacktestSession, BacktestParameters
    from test_feature_engine import daily_history, minute_history
    from test_strategy_engine import bar

    base = [bar(3, 99.5, 99.9, 99.4, 99.8, 100), bar(4, 99.7, 99.95, 99.6, 99.85, 100), bar(5, 99.8, 100, 99.7, 99.9, 100)]
    breakout = bar(6, 99.9, 101.2, 99.8, 101, 250)
    captured = quote().model_copy(update={"timestamp": breakout.end, "last": breakout.close, "day_high": breakout.high})
    request = BacktestReplayRequest(run_id=UUID("10000000-0000-4000-8000-000000000001"), config_version="entry-filter-test",
                                   strategies=["HIGH_OF_DAY_BREAKOUT"], assumptions={"startingCapital": 10000, "positionSize": 1000, "slippageBps": 2, "feePerTrade": 0}, parameters=BacktestParameters(latest_ready_time="10:00"),
                                   sessions=[BacktestSession(session=session(), candles=[*daily_history(), *minute_history(), *base, breakout], quotes=[captured])])
    result = replay(request)
    assert not any(value.state == "READY" for value in result.timeline)
    assert result.entry_filter_diagnostics == {"HIGH_OF_DAY_BREAKOUT": {"READY_WINDOW_CLOSED": {"blockedEvaluations": 1, "blockedInstances": 1}}}
