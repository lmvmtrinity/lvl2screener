from zoneinfo import ZoneInfo
from uuid import UUID, uuid4

from .models import BacktestParameters, CandleRecord, ContextEvaluation, FeatureSnapshot, ScannerProfileConfig, SessionStart, SetupScoreComponents, SetupScoreContribution, StrategyEvaluation, StrategyParameters, StrategyState, StrategyStateEvent
from .scoring import SPREAD_PREFERRED_MAX_PCT, score_setup
from .strategies import CONTEXT_REGISTRY, STRATEGY_REGISTRY
from .strategies.base import StrategyContext, StrategyMemory, formation_evidence

STRATEGY_VERSION = "1.0.0"
CONFIG_VERSION = "phase4-default-v1"
DEFAULT_PROFILES = (
    (UUID("10000000-0000-4000-8000-000000000081"), "ORB Standard", "ORB_RETEST", 0),
    (UUID("10000000-0000-4000-8000-000000000082"), "VWAP Hold", "VWAP_HOLD", 1),
)


def _clock_minutes(value: str) -> int:
    try:
        hours, minutes = (int(part) for part in value.split(":"))
    except (ValueError, TypeError) as error:
        raise ValueError(f"Invalid session time: {value}") from error
    if not 0 <= hours <= 23 or not 0 <= minutes <= 59:
        raise ValueError(f"Invalid session time: {value}")
    return hours * 60 + minutes


class StrategyEngine:
    def __init__(self, parameters: BacktestParameters | None = None, config_version: str = CONFIG_VERSION) -> None:
        self._memory: dict[tuple[UUID, str], StrategyMemory] = {}
        self._session: SessionStart | None = None
        self._parameters = parameters or BacktestParameters()
        self._config_version = config_version
        self._profiles = self._default_profiles(self._parameters, config_version)
        self._context_profiles: list[ScannerProfileConfig] = []

    def reset(self) -> None:
        self._memory.clear()

    def start_session(self, session: SessionStart) -> None:
        values = [session.opening_range.start, session.opening_range.end, session.scanning.start,
                  session.entries.preferred_start, session.entries.preferred_end,
                  session.entries.hard_end, session.scanning.end]
        minutes = [_clock_minutes(value) for value in values]
        if minutes != sorted(minutes) or session.scanning.end != session.entries.hard_end:
            raise ValueError("Session windows must be ordered and scanning.end must equal entries.hardEnd")
        self._session = session
        if session.profiles:
            self.configure_profiles(session.profiles)

    def configure_profiles(self, values: list[ScannerProfileConfig]) -> None:
        profiles = []
        context_profiles = []
        for profile in values:
            if profile.analysis_kind == "SETUP":
                setup_definition = STRATEGY_REGISTRY.get(profile.strategy)
                if setup_definition is None or setup_definition.version != profile.strategy_version:
                    raise ValueError(f"Unknown setup module {profile.strategy} {profile.strategy_version}")
                profile.parameters = setup_definition.validate(profile.parameters)
                if profile.enabled:
                    profiles.append(profile)
            else:
                context_definition = CONTEXT_REGISTRY.get(profile.strategy)
                if context_definition is None or context_definition.version != profile.strategy_version:
                    raise ValueError(f"Unknown context module {profile.strategy} {profile.strategy_version}")
                if profile.enabled:
                    context_profiles.append(profile)
        self._profiles = sorted(profiles, key=lambda value: value.display_order)
        self._context_profiles = sorted(context_profiles, key=lambda value: value.display_order)
        self._memory.clear()

    def evaluate(self, snapshot: FeatureSnapshot, bars: list[CandleRecord] | StrategyContext) -> tuple[list[StrategyEvaluation], list[StrategyStateEvent], list[ContextEvaluation]]:
        evaluations: list[StrategyEvaluation] = []
        events: list[StrategyStateEvent] = []
        contexts: list[ContextEvaluation] = []
        context = bars if isinstance(bars, StrategyContext) else StrategyContext(bars=bars)
        for profile in self._profiles:
            strategy = profile.strategy
            memory = self._memory.setdefault((snapshot.instrument_id, str(profile.profile_id)), StrategyMemory())
            previous = memory.state
            state, reasons = self._next(strategy, memory, snapshot, context, profile.parameters)
            state, reasons = self._apply_session_gate(state, reasons, snapshot, profile)
            memory.state = state
            evaluation = self._evaluation(profile, memory, context, state, reasons, snapshot)
            evaluations.append(evaluation)
            if state != previous:
                events.append(StrategyStateEvent(**evaluation.model_dump(), event_id=uuid4(), previous_state=previous))
            # A terminal formation re-arms: clear this formation's working state (and
            # its setup-instance id) so a fresh formation can be detected on a later tick.
            if state in ("INVALIDATED", "EXPIRED"):
                if memory.formation_key is not None:
                    if memory.retired_formation_keys is None:
                        memory.retired_formation_keys = set()
                    memory.retired_formation_keys.add(memory.formation_key)
                memory.reset_formation()
        for profile in self._context_profiles:
            module = CONTEXT_REGISTRY[profile.strategy]
            status, score, observed, benchmark, reasons, components, missing_flags = module.evaluate(snapshot, context, profile.parameters)
            contexts.append(ContextEvaluation(
                market_id=snapshot.market_id, instrument_id=snapshot.instrument_id, symbol=snapshot.symbol, timestamp=snapshot.timestamp,
                profile_id=profile.profile_id, profile_name=profile.profile_name, signal=module.key,
                signal_version=module.version, config_version=profile.config_version, status=status,
                context_score=score, context_score_components=components, missing_data_flags=missing_flags,
                observed_value=observed,
                benchmark_symbol=benchmark.symbol if benchmark else None,
                benchmark_value=benchmark.change_from_open_pct if benchmark else None,
                benchmark_timestamp=benchmark.timestamp if benchmark else None,
                reason_codes=reasons, feature_snapshot=snapshot,
            ))
        return evaluations, events, contexts

    def _apply_session_gate(self, state: StrategyState, reasons: list[str], snapshot: FeatureSnapshot, profile: ScannerProfileConfig) -> tuple[StrategyState, list[str]]:
        if self._session is None or state in ("HALTED", "DATA_STALE", "INVALIDATED"):
            return state, reasons
        entries = profile.entry_window or self._session.entries
        local = snapshot.timestamp.astimezone(ZoneInfo(self._session.timezone))
        current = local.hour * 60 + local.minute
        scan_start = _clock_minutes(self._session.scanning.start)
        preferred_start = _clock_minutes(entries.preferred_start)
        preferred_end = _clock_minutes(entries.preferred_end)
        hard_end = _clock_minutes(entries.hard_end)
        if current < scan_start:
            return "INACTIVE", [*reasons, "SCANNING_WINDOW_NOT_OPEN"]
        if current >= hard_end:
            return "EXPIRED", [*reasons, "NEW_ENTRY_WINDOW_CLOSED"]
        if state == "READY" and current < preferred_start:
            return "FORMING", [*reasons, "WAITING_FOR_PREFERRED_ENTRY_WINDOW"]
        if state == "READY" and current >= preferred_end:
            return state, [*reasons, "OUTSIDE_PREFERRED_ENTRY_WINDOW"]
        if state == "READY":
            return state, [*reasons, "PREFERRED_ENTRY_WINDOW"]
        return state, reasons

    def _next(self, strategy: str, memory: StrategyMemory, f: FeatureSnapshot, context: StrategyContext, parameters: StrategyParameters) -> tuple[StrategyState, list[str]]:
        base = self._base_reasons(f)
        if f.data_status == "HALTED":
            return "HALTED", [*base, "HALTED"]
        if not f.actionable or f.data_status != "REALTIME":
            return "DATA_STALE", [*base, "DATA_STALE"]
        if f.spread_pct > parameters.spread_hard_max_pct:
            return ("INVALIDATED" if memory.state in ("FORMING", "READY") else "INACTIVE"), [*base, "SPREAD_TOO_WIDE"]
        if f.warming_up:
            return "INACTIVE", [*base, "FEATURES_WARMING_UP"]
        if f.atr_pct is None or f.atr_pct < parameters.atr_pct_min:
            return "INACTIVE", [*base, "ATR_BELOW_MINIMUM"]
        if f.rvol_at_time is None or f.rvol_at_time < parameters.rvol_at_time_min:
            return "INACTIVE", [*base, "RVOL_BELOW_MINIMUM"]
        if parameters.daily_ema_filter_enabled:
            daily_context = context.daily_ema_context
            status = getattr(daily_context, "status", None)
            if daily_context is None or status == "UNAVAILABLE":
                return "INACTIVE", [*base, "DAILY_EMA_CONTEXT_UNAVAILABLE"]
            if status != "BULLISH":
                return "INACTIVE", [*base, "DAILY_EMA_FILTER_FAILED"]
        module = STRATEGY_REGISTRY.get(strategy)
        if module is None:
            raise ValueError(f"Unknown strategy module {strategy}")
        return module.next_state(memory, f, context, parameters, base)

    def _base_reasons(self, f: FeatureSnapshot) -> list[str]:
        reasons = ["REALTIME_DATA"] if f.data_status == "REALTIME" and f.actionable else []
        reasons.append("SPREAD_GOOD" if f.spread_pct <= SPREAD_PREFERRED_MAX_PCT else "SPREAD_CAUTION")
        if f.rvol_at_time is not None and f.rvol_at_time >= 1.5:
            reasons.append("RVOL_STRONG")
        if f.close_above_vwap:
            reasons.append("ABOVE_VWAP")
        if f.distance_from_vwap_atr is not None and f.distance_from_vwap_atr >= 0.75:
            reasons.append("OVEREXTENDED")
        return list(dict.fromkeys(reasons))

    def _evaluation(self, profile: ScannerProfileConfig, memory: StrategyMemory, context: StrategyContext, state: StrategyState, reasons: list[str], f: FeatureSnapshot) -> StrategyEvaluation:
        module = STRATEGY_REGISTRY[profile.strategy]
        entry, stop, target = module.trade_references(
            memory, f, context, state, profile.parameters
        )
        rr = None if entry is None or stop is None or target is None or entry == stop else (target - entry) / (entry - stop)
        # Scoring runs after the state machine and the trade references, so a score
        # can describe a setup but can never promote one to READY.
        score = score_setup(module.score_rules, f, profile.parameters, memory, state, reasons, entry, stop, rr)
        return StrategyEvaluation(
            entry_window=profile.entry_window or (self._session.entries if self._session else None),
            market_id=f.market_id, instrument_id=f.instrument_id, symbol=f.symbol, timestamp=f.timestamp, profile_id=profile.profile_id,
            profile_name=profile.profile_name, strategy=profile.strategy, strategy_version=profile.strategy_version,
            config_version=profile.config_version, state=state, score=score.total, setup_score=score.total,
            score_version=score.version, score_components=SetupScoreComponents(**score.components),
            score_explanation=[SetupScoreContribution(key=value.key, group=value.group, label=value.label, points=value.points,
                                                      maximum=value.maximum, value=value.value, detail=value.detail)
                               for value in score.contributions],
            setup_instance_id=memory.setup_instance_id,
            stop_policy=profile.parameters.stop_policy,
            pattern_stop_reference=memory.stop_level,
            stop_selection_reason=("PATTERN" if stop == memory.stop_level else "SUPPORT") if stop is not None else None,
            formation_evidence=formation_evidence(memory, module.key),
            reason_codes=list(dict.fromkeys(reasons)), entry_reference=entry, stop_reference=stop,
            target_reference=target, estimated_rr=rr, feature_snapshot=f)

    @staticmethod
    def _default_profiles(parameters: StrategyParameters, config_version: str) -> list[ScannerProfileConfig]:
        return [ScannerProfileConfig(profile_id=profile_id, profile_name=name, strategy=strategy,
                                     config_version=config_version, parameters=parameters, display_order=order)
                for profile_id, name, strategy, order in DEFAULT_PROFILES]
