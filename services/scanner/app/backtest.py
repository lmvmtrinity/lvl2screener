from collections import defaultdict
from datetime import datetime
from itertools import groupby
from math import floor
from statistics import fmean, median
from threading import Event
from uuid import NAMESPACE_URL, uuid4, uuid5
from zoneinfo import ZoneInfo

from .feature_engine import FeatureEngine
from .models import (
    BacktestDataQuality,
    BacktestMetrics,
    BacktestReplayRequest,
    BacktestReplayResult,
    BacktestSignalReplayResult,
    BacktestSlice,
    BacktestTimelineEvent,
    BacktestTrade,
    CandleRecord,
    ContextEvaluation,
    ScannerProfileConfig,
    StrategyStateEvent,
)
from .strategy_engine import StrategyEngine
from .replay_cancellation import ReplayCancelled


def replay(request: BacktestReplayRequest) -> BacktestReplayResult:
    _validate_market_homogeneous(request)
    events, contexts_by_signal, session_candles, quality = _generate_signals(request)
    timezone = request.sessions[0].session.timezone if request.sessions else "America/Toronto"
    trades = _simulate_trades(request, events, session_candles, contexts_by_signal, timezone)
    warnings = list(quality.warnings)
    if events and not trades:
        warnings.append("No READY event had complete long-side reference levels and qualifying execution data.")
    timeline = [
        BacktestTimelineEvent(
            instrument_id=value.instrument_id,
            symbol=value.symbol,
            strategy=value.strategy,
            timestamp=value.timestamp,
            previous_state=value.previous_state,
            state=value.state,
            score=value.score,
            reason_codes=value.reason_codes,
            setup_instance_id=value.setup_instance_id,
        )
        for value in events
    ]
    return BacktestReplayResult(
        metrics=_metrics(trades, events, request.assumptions.starting_capital),
        analyses=_analyses(trades, timezone),
        trades=trades,
        timeline=timeline,
        data_quality=quality.model_copy(update={"warnings": warnings}),
    )


def replay_signals(request: BacktestReplayRequest, cancelled: Event | None = None) -> BacktestSignalReplayResult:
    """Generate deterministic scanner evidence without simulating any fills."""
    _validate_market_homogeneous(request)
    events, contexts_by_signal, _, quality = _generate_signals(request, cancelled)
    contexts = [
        context
        for key in sorted(contexts_by_signal, key=lambda value: (str(value[0]), value[1], value[2]))
        for context in contexts_by_signal[key]
    ]
    return BacktestSignalReplayResult(events=events, contexts=contexts, data_quality=quality)


def _check_replay_cancellation(cancelled: Event | None) -> None:
    if cancelled is not None and cancelled.is_set():
        raise ReplayCancelled("Signal replay cancelled before completion")


def _validate_market_homogeneous(request: BacktestReplayRequest) -> None:
    """Reject a replay whose transport market disagrees with any session payload."""
    mismatches = [
        item.session.market_id
        for item in request.sessions
        if item.session.market_id != request.market_id
    ]
    if mismatches:
        raise ValueError(
            f"Replay market {request.market_id} does not match session market(s): "
            f"{sorted(set(mismatches))}"
        )


def _generate_signals(
    request: BacktestReplayRequest,
    cancelled: Event | None = None,
) -> tuple[
    list[StrategyStateEvent],
    dict[tuple[object, str, datetime], list[ContextEvaluation]],
    list[tuple[datetime, list[CandleRecord]]],
    BacktestDataQuality,
]:
    events: list[StrategyStateEvent] = []
    contexts_by_signal: dict[tuple[object, str, datetime], list[ContextEvaluation]] = {}
    session_candles: list[tuple[datetime, list[CandleRecord]]] = []
    quote_count = 0
    candle_count = 0

    for item in sorted(request.sessions, key=lambda value: value.session.start_time):
        _check_replay_cancellation(cancelled)
        engine = FeatureEngine()
        engine.strategies = StrategyEngine(request.parameters, request.config_version)
        engine.start_session(item.session)
        setup_profiles = [
            ScannerProfileConfig(
                profile_id=uuid5(NAMESPACE_URL, f"tsx-scanner:backtest:{request.run_id}:{strategy}"),
                profile_name=f"Backtest {strategy}",
                market_id=request.market_id,
                strategy=strategy,
                config_version=request.config_version,
                parameters=request.parameters,
                display_order=index,
            )
            for index, strategy in enumerate(request.strategies)
        ]
        context_profiles = [
            ScannerProfileConfig(
                profile_id=uuid5(NAMESPACE_URL, f"tsx-scanner:backtest:{request.run_id}:{signal}"),
                profile_name=f"Backtest {signal}",
                market_id=request.market_id,
                strategy=signal,
                analysis_kind="CONTEXT",
                config_version=request.config_version,
                parameters=request.parameters,
                display_order=len(setup_profiles) + index,
            )
            for index, signal in enumerate(("MARKET_RELATIVE_STRENGTH", "SECTOR_RELATIVE_STRENGTH"))
        ]
        engine.strategies.configure_profiles([*setup_profiles, *context_profiles])
        candles = sorted((value for value in item.candles if value.is_complete), key=lambda value: value.end)
        quotes = sorted(item.quotes, key=lambda value: value.timestamp)
        quote_count += len(quotes)
        candle_count += len(candles)
        cursor = 0
        for timestamp, quote_group in groupby(quotes, key=lambda value: value.timestamp):
            _check_replay_cancellation(cancelled)
            known: list[CandleRecord] = []
            while cursor < len(candles) and candles[cursor].end <= timestamp:
                known.append(candles[cursor])
                cursor += 1
            if known:
                engine.ingest_candles(known)
            snapshots = engine.ingest_quotes(
                list(quote_group), include_benchmark_features=False
            )
            for snapshot in snapshots:
                _check_replay_cancellation(cancelled)
                if not engine.is_candidate(snapshot.instrument_id):
                    continue
                _, changed, contexts = engine.strategies.evaluate(snapshot, engine.strategy_context(snapshot))
                setup_events = [event for event in changed if event.strategy in request.strategies]
                events.extend(setup_events)
                # Context evaluations are only consumed alongside an emitted setup event. Retaining
                # them for every quote snapshot made a long US session grow unboundedly in memory
                # without changing setup-event evidence.
                if setup_events:
                    contexts_by_signal[(snapshot.instrument_id, snapshot.symbol, snapshot.timestamp)] = contexts
        current = [
            value for value in candles if value.timeframe == "OneMinute" and value.start >= item.session.start_time
        ]
        session_candles.append((item.session.start_time, current))

    _check_replay_cancellation(cancelled)
    warnings: list[str] = []
    if quote_count == 0:
        warnings.append("No captured quote snapshots were available for the selected range and universe.")
    if not any(candles for _, candles in session_candles):
        warnings.append("No completed one-minute candles were available for execution simulation.")
    return (
        events,
        contexts_by_signal,
        session_candles,
        BacktestDataQuality(
            quote_snapshots=quote_count,
            candles=candle_count,
            sessions=len(request.sessions),
            spread="CAPTURED" if quote_count else "UNAVAILABLE",
            warnings=warnings,
        ),
    )


def _simulate_trades(
    request: BacktestReplayRequest,
    events: list[StrategyStateEvent],
    sessions: list[tuple[datetime, list[CandleRecord]]],
    contexts_by_signal: dict[tuple[object, str, datetime], list[ContextEvaluation]] | None = None,
    timezone: str = "America/Toronto",
) -> list[BacktestTrade]:
    contexts_by_signal = contexts_by_signal or {}
    bars_by_session: dict[tuple[object, object], list[CandleRecord]] = {}
    for start, candles in sessions:
        by_instrument: dict[object, list[CandleRecord]] = defaultdict(list)
        for candle in candles:
            by_instrument[candle.instrument_id].append(candle)
        for instrument_id, values in by_instrument.items():
            bars_by_session[(_local_date(start, timezone), instrument_id)] = sorted(values, key=lambda value: value.start)

    result: list[BacktestTrade] = []
    sectors = {
        instrument.instrument_id: instrument.sector
        for item in request.sessions
        for instrument in item.session.instruments
    }
    slip = request.assumptions.slippage_bps / 10_000
    seen_ready_instances: set[str] = set()
    for event in events:
        if event.state != "READY" or event.score < request.parameters.score_cutoff:
            continue
        ready_identity = _ready_identity(event)
        if ready_identity in seen_ready_instances:
            continue
        seen_ready_instances.add(ready_identity)
        if event.entry_reference is None:
            continue
        if request.assumptions.stop_method == "STRUCTURAL" and event.stop_reference is None:
            continue
        if request.assumptions.reward_risk_ratio is None and event.target_reference is None:
            continue
        entry = event.entry_reference * (1 + slip)
        stop = event.stop_reference
        feature = getattr(event, "feature_snapshot", None)
        if request.assumptions.stop_method == "ATR":
            atr = feature.atr_14 if feature is not None else None
            if atr is None:
                continue
            stop = event.entry_reference - atr * request.assumptions.atr_stop_multiple
        if stop is None:
            continue
        target = event.target_reference
        if request.assumptions.reward_risk_ratio is not None:
            target = event.entry_reference + (event.entry_reference - stop) * request.assumptions.reward_risk_ratio
        if target is None or not stop < entry < target:
            continue
        shares = floor(request.assumptions.position_size / entry)
        if shares < 1:
            continue
        # Exclude the partially elapsed bar containing the signal; its low/high may have occurred before entry.
        future = [
            value
            for value in bars_by_session.get((_local_date(event.timestamp, timezone), event.instrument_id), [])
            if value.start >= event.timestamp
        ]
        if not future:
            continue
        exit_bar = future[-1]
        exit_reason = "SESSION_CLOSE"
        raw_exit = exit_bar.close
        for value in future:
            # OHLC cannot reveal intrabar ordering, so same-bar target/stop collisions are resolved conservatively.
            if value.low <= stop:
                exit_bar, raw_exit, exit_reason = value, min(value.open, stop), "STOP"
                break
            if value.high >= target:
                exit_bar, raw_exit, exit_reason = value, target, "TARGET"
                break
        exit_price = raw_exit * (1 - slip)
        gross = (exit_price - entry) * shares
        net = gross - request.assumptions.fee_per_trade
        initial_risk = (entry - stop) * shares
        contexts = contexts_by_signal.get((event.instrument_id, event.symbol, event.timestamp), [])
        usable_contexts = [value.context_score for value in contexts if value.status not in ("UNAVAILABLE", "STALE")]
        context_score = round(fmean(usable_contexts)) if usable_contexts else 50
        result.append(
            BacktestTrade(
                id=uuid4(),
                run_id=request.run_id,
                instrument_id=event.instrument_id,
                symbol=event.symbol,
                strategy=event.strategy,
                strategy_version=event.strategy_version,
                config_version=request.config_version,
                signal_timestamp=event.timestamp,
                score=event.score,
                entry_time=event.timestamp,
                entry_price=round(entry, 6),
                stop_price=stop,
                target_price=target,
                exit_time=exit_bar.end,
                exit_price=round(exit_price, 6),
                shares=shares,
                exit_reason=exit_reason,
                gross_pnl=round(gross, 4),
                net_pnl=round(net, 4),
                r_multiple=round(net / initial_risk, 6),
                hold_minutes=max(0, (exit_bar.end - event.timestamp).total_seconds() / 60),
                reason_codes=event.reason_codes,
                sector=sectors.get(event.instrument_id),
                atr_pct=feature.atr_pct if feature is not None else None,
                rvol_at_time=feature.rvol_at_time if feature is not None else None,
                context_score=context_score,
                contexts=contexts,
                setup_instance_id=event.setup_instance_id,
            )
        )
    return sorted(result, key=lambda value: value.entry_time)


def _metrics(trades: list[BacktestTrade], events: list[StrategyStateEvent], starting_capital: float) -> BacktestMetrics:
    pnl = [value.net_pnl for value in trades]
    winners = [value for value in pnl if value > 0]
    losers = [value for value in pnl if value < 0]
    r_values = [value.r_multiple for value in trades]
    ready = len({_ready_identity(value) for value in events if value.state == "READY"})
    win_rate = len(winners) / len(trades) if trades else 0
    average_win = fmean(winners) if winners else 0
    average_loss = abs(fmean(losers)) if losers else 0
    expectancy = win_rate * average_win - (1 - win_rate) * average_loss
    peak = starting_capital
    equity = starting_capital
    maximum_drawdown = 0.0
    for value in pnl:
        equity += value
        peak = max(peak, equity)
        maximum_drawdown = max(maximum_drawdown, peak - equity)
    gross_profit = sum(winners)
    gross_loss = abs(sum(losers))
    false_breakouts = sum(value.exit_reason == "STOP" for value in trades)
    return BacktestMetrics(
        signals_generated=len(events),
        ready_signals=ready,
        trades_simulated=len(trades),
        wins=len(winners),
        losses=len(losers),
        win_rate=round(win_rate * 100, 4),
        average_win=round(average_win, 4),
        average_loss=round(average_loss, 4),
        average_r=round(fmean(r_values), 6) if r_values else 0,
        median_r=round(median(r_values), 6) if r_values else 0,
        profit_factor=None if gross_loss == 0 else round(gross_profit / gross_loss, 6),
        expectancy=round(expectancy, 4),
        net_pnl=round(sum(pnl), 4),
        maximum_drawdown=round(maximum_drawdown, 4),
        maximum_drawdown_pct=round(maximum_drawdown / starting_capital * 100, 6),
        false_breakout_rate=round(false_breakouts / len(trades) * 100, 4) if trades else 0,
        signal_to_trade_conversion=round(len(trades) / ready * 100, 4) if ready else 0,
        average_hold_minutes=round(fmean(value.hold_minutes for value in trades), 4) if trades else 0,
    )


def _analyses(trades: list[BacktestTrade], timezone: str = "America/Toronto") -> list[BacktestSlice]:
    grouped: dict[tuple[str, str], list[BacktestTrade]] = defaultdict(list)
    for trade in trades:
        grouped[("STRATEGY", trade.strategy)].append(trade)
        grouped[("SCORE_BUCKET", _score_bucket(trade.score))].append(trade)
        grouped[("TIME_OF_DAY", _time_bucket(trade.entry_time, timezone))].append(trade)
        grouped[("SECTOR", trade.sector or "UNKNOWN")].append(trade)
        grouped[("ATR_REGIME", _atr_bucket(trade.atr_pct))].append(trade)
        grouped[("RVOL_REGIME", _rvol_bucket(trade.rvol_at_time))].append(trade)
    result: list[BacktestSlice] = []
    for (dimension, bucket), values in sorted(grouped.items()):
        pnl = [value.net_pnl for value in values]
        wins = sum(value > 0 for value in pnl)
        average_win = fmean(value for value in pnl if value > 0) if wins else 0
        loss_values = [value for value in pnl if value < 0]
        average_loss = abs(fmean(loss_values)) if loss_values else 0
        rate = wins / len(values)
        result.append(
            BacktestSlice(
                dimension=dimension,
                bucket=bucket,
                trades=len(values),
                wins=wins,
                win_rate=round(rate * 100, 4),
                average_r=round(fmean(value.r_multiple for value in values), 6),
                expectancy=round(rate * average_win - (1 - rate) * average_loss, 4),
                net_pnl=round(sum(pnl), 4),
            )
        )
    return result


def _score_bucket(score: int) -> str:
    if score < 70:
        return "0-69"
    if score < 80:
        return "70-79"
    if score < 90:
        return "80-89"
    return "90-100"


def _time_bucket(value: datetime, timezone: str = "America/Toronto") -> str:
    local = value.astimezone(ZoneInfo(timezone))
    minutes = local.hour * 60 + local.minute
    if minutes < 10 * 60:
        return "09:30-09:59"
    if minutes < 11 * 60:
        return "10:00-10:59"
    return "11:00+"


def _local_date(value: datetime, timezone: str = "America/Toronto") -> object:
    return value.astimezone(ZoneInfo(timezone)).date()


def _ready_identity(event: StrategyStateEvent) -> str:
    """Count one observation per authoritative setup lifecycle.

    Older captured payloads may not contain setup identity, so the immutable
    event id (or final timestamp tuple for constructed legacy tests) remains a
    conservative compatibility fallback.
    """
    setup_instance_id = getattr(event, "setup_instance_id", None)
    if setup_instance_id is not None:
        return f"setup:{setup_instance_id}"
    event_id = getattr(event, "event_id", None)
    if event_id is not None:
        return f"event:{event_id}"
    return f"legacy:{event.instrument_id}:{event.strategy}:{event.timestamp.isoformat()}"


def _atr_bucket(value: float | None) -> str:
    if value is None:
        return "UNKNOWN"
    if value < 1.5:
        return "<1.5%"
    if value < 2.5:
        return "1.5-2.49%"
    return "2.5%+"


def _rvol_bucket(value: float | None) -> str:
    if value is None:
        return "UNKNOWN"
    if value < 1.5:
        return "<1.5x"
    if value < 2.5:
        return "1.5-2.49x"
    return "2.5x+"
