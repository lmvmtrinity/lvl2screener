from datetime import timedelta
from uuid import UUID

from app.models import ScannerProfileConfig, StrategyParameters
from app.scoring import GROUP_MAXIMUM, SCORE_GROUPS, SCORE_VERSION, SHARED_FEATURE_OWNERS, saturating
from app.strategies import STRATEGY_REGISTRY
from app.strategy_engine import StrategyEngine
from test_feature_engine import five_minute_history, quote, session, warmed_engine
from test_strategy_engine import bar


def orb_replay() -> tuple[StrategyEngine, object, list]:
    """ORB retest replay that reaches READY, so structure and confirmation can score."""
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    assert snapshot.opening_range is not None
    orh = snapshot.opening_range.high
    base = [bar(3, orh - .1, orh, orh - .2, orh - .05, 100), bar(4, orh - .05, orh, orh - .1, orh, 100), bar(5, orh, orh + .02, orh - .05, orh, 100)]
    breakout = bar(6, orh, orh + .3, orh, orh + .2, 200)
    retest = bar(7, orh + .2, orh + .25, orh - .05, orh + .05, 120)
    engine = StrategyEngine()
    engine.evaluate(snapshot.model_copy(update={"timestamp": breakout.end, "price": breakout.close}), [*base, breakout])
    ready = engine.evaluate(snapshot.model_copy(update={"timestamp": retest.end, "price": retest.close}), [*base, breakout, retest])[0]
    return engine, snapshot, ready


def test_every_component_and_penalty_is_recorded_with_its_version() -> None:
    _engine, _snapshot, evaluations = orb_replay()
    orb = next(value for value in evaluations if value.strategy == "ORB_RETEST")

    assert orb.state == "READY"
    assert orb.score_version == SCORE_VERSION
    assert orb.score_version != orb.strategy_version and orb.score_version != orb.config_version
    assert sum(orb.score_components.model_dump().values()) == orb.setup_score == orb.score
    for group in SCORE_GROUPS:
        recorded = sum(value.points for value in orb.score_explanation if value.group == group)
        assert recorded >= getattr(orb.score_components, group) or GROUP_MAXIMUM[group] == 0
    assert {"ORB_RETEST_CONFIRMED", "DISTANCE_TO_INVALIDATION", "RISK_REWARD_VALIDITY", "SPREAD_QUALITY", "RELATIVE_VOLUME", "SETUP_FRESHNESS"} <= {value.key for value in orb.score_explanation}


def test_the_explanation_accounts_for_the_difference_between_two_scores() -> None:
    """The UI must be able to say why one profile scored higher than another."""
    _engine, _snapshot, evaluations = orb_replay()
    orb = next(value for value in evaluations if value.strategy == "ORB_RETEST")
    vwap = next(value for value in evaluations if value.strategy == "VWAP_HOLD")

    difference = orb.setup_score - vwap.setup_score
    by_group = {group: getattr(orb.score_components, group) - getattr(vwap.score_components, group) for group in SCORE_GROUPS}
    assert sum(by_group.values()) == difference
    assert by_group["confirmation"] != 0 or by_group["pattern"] != 0


def test_no_shared_feature_is_rewarded_by_two_components() -> None:
    owners = list(SHARED_FEATURE_OWNERS.values())
    assert len(SHARED_FEATURE_OWNERS) == len(set(SHARED_FEATURE_OWNERS))
    assert set(owners) <= set(SCORE_GROUPS)
    for module in STRATEGY_REGISTRY.values():
        groups: dict[str, str] = {}
        for rule in module.score_rules:
            assert rule.reason not in groups, f"{module.key} scores {rule.reason} twice"
            groups[rule.reason] = rule.group
        for group in ("pattern", "confirmation"):
            assert sum(rule.points for rule in module.score_rules if rule.group == group) <= GROUP_MAXIMUM[group] * 2


def test_component_budgets_sum_to_one_hundred() -> None:
    assert sum(GROUP_MAXIMUM[group] for group in SCORE_GROUPS) == 100


def test_saturation_curve_is_bounded_and_monotonic() -> None:
    values = [saturating(value / 4, 1.5, 8) for value in range(0, 200)]
    assert values == sorted(values)
    assert values[0] == 0 and max(values) <= 8
    assert saturating(1.5, 1.5, 8) == 4


def test_a_high_score_never_creates_ready() -> None:
    """A perfect liquidity and timing profile still cannot promote an unformed setup."""
    snapshot = warmed_engine().ingest_quotes([quote()])[0].model_copy(update={"spread_pct": .001, "rvol_at_time": 12, "atr_pct": 6})
    evaluations = StrategyEngine().evaluate(snapshot, five_minute_history())[0]

    assert all(value.state != "READY" for value in evaluations)
    assert all(value.setup_score < 60 or value.state in ("WATCH", "FORMING") for value in evaluations)


def test_strong_context_cannot_raise_a_setup_score() -> None:
    from app.strategies.base import BenchmarkObservation, StrategyContext

    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    profiles = [
        ScannerProfileConfig(profile_id=UUID(int=1), profile_name="ORB", strategy="ORB_RETEST", config_version="phase4"),
        ScannerProfileConfig(profile_id=UUID(int=2), profile_name="Market Context", strategy="MARKET_RELATIVE_STRENGTH", analysis_kind="CONTEXT", config_version="phase4", display_order=1),
    ]
    neutral = StrategyContext(bars=five_minute_history(), market_benchmark=BenchmarkObservation("XIU.TO", 5, snapshot.timestamp, "REALTIME", True))
    strong = StrategyContext(bars=five_minute_history(), market_benchmark=BenchmarkObservation("XIU.TO", -5, snapshot.timestamp, "REALTIME", True))

    weak_engine = StrategyEngine(); weak_engine.configure_profiles(profiles)
    strong_engine = StrategyEngine(); strong_engine.configure_profiles(profiles)
    weak_setups, _, weak_contexts = weak_engine.evaluate(snapshot, neutral)
    strong_setups, _, strong_contexts = strong_engine.evaluate(snapshot, strong)

    assert strong_contexts[0].context_score > weak_contexts[0].context_score
    assert [(value.state, value.setup_score) for value in strong_setups] == [(value.state, value.setup_score) for value in weak_setups]


def test_non_actionable_data_caps_the_score_and_records_the_penalty() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0].model_copy(update={"actionable": False, "data_status": "DELAYED"})
    evaluations = StrategyEngine().evaluate(snapshot, five_minute_history())[0]

    for value in evaluations:
        assert value.state == "DATA_STALE" and value.setup_score < 60
        keys = {contribution.key for contribution in value.score_explanation}
        assert "DATA_NOT_ACTIONABLE" in keys
        assert value.score_components.penalties < 0


def test_timing_components_follow_the_session_windows() -> None:
    engine = StrategyEngine()
    engine.start_session(session())
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    inside = engine.evaluate(snapshot, five_minute_history())[0][0]
    late = engine.evaluate(snapshot.model_copy(update={"timestamp": snapshot.timestamp + timedelta(hours=6)}), five_minute_history())[0][0]

    assert inside.score_components.timing >= late.score_components.timing
    assert any(value.key == "TIME_OF_DAY" for value in late.score_explanation)


def test_replaying_the_same_inputs_reproduces_identical_components_and_rank() -> None:
    first = orb_replay()[2]
    second = orb_replay()[2]
    assert [value.model_dump(exclude={"feature_snapshot"}) for value in first] == [value.model_dump(exclude={"feature_snapshot"}) for value in second]


def test_score_cutoff_parameter_never_changes_state() -> None:
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    engine = StrategyEngine()
    engine.configure_profiles([ScannerProfileConfig(profile_id=UUID(int=3), profile_name="Cutoff", strategy="ORB_RETEST",
                                                    config_version="phase4", parameters=StrategyParameters(score_cutoff=100))])
    evaluation = engine.evaluate(snapshot, five_minute_history())[0][0]
    assert evaluation.state == "WATCH"
