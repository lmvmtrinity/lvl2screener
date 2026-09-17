"""Property tests for explainable scoring.

`score_setup` is the single choke point every strategy's setup score passes
through. These properties hold for any feature snapshot, not just the fixed
fixtures in test_phase4_scoring.py, so they exercise inputs those examples
never construct (extreme spreads, missing VWAP distance, inverted risk
geometry) without ever crashing or breaking the score bound.
"""

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.scoring import NON_TRADEABLE_SCORE_CAP, NON_TRADEABLE_STATES
from app.strategy_engine import StrategyEngine
from test_feature_engine import five_minute_history, quote, warmed_engine


def perturbed_snapshot(spread_pct: float, rvol_at_time: float, atr_pct: float, change_from_open_pct: float, data_status: str, actionable: bool):
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    return snapshot.model_copy(update={
        "spread_pct": spread_pct,
        "rvol_at_time": rvol_at_time,
        "atr_pct": atr_pct,
        "change_from_open_pct": change_from_open_pct,
        "data_status": data_status,
        "actionable": actionable,
    })


feature_perturbation = st.tuples(
    st.floats(min_value=0, max_value=50, allow_nan=False),
    st.floats(min_value=0, max_value=50, allow_nan=False),
    st.floats(min_value=0, max_value=50, allow_nan=False),
    st.floats(min_value=-50, max_value=50, allow_nan=False),
    st.sampled_from(["REALTIME", "DELAYED", "HALTED"]),
    st.booleans(),
)


@given(feature_perturbation)
@settings(max_examples=150, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_score_never_leaves_zero_to_one_hundred(perturbation: tuple[float, float, float, float, str, bool]) -> None:
    snapshot = perturbed_snapshot(*perturbation)
    evaluations = StrategyEngine().evaluate(snapshot, five_minute_history())[0]
    for evaluation in evaluations:
        assert 0 <= evaluation.setup_score <= 100


@given(feature_perturbation)
@settings(max_examples=150, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_non_tradeable_states_never_exceed_their_score_cap(perturbation: tuple[float, float, float, float, str, bool]) -> None:
    snapshot = perturbed_snapshot(*perturbation)
    evaluations = StrategyEngine().evaluate(snapshot, five_minute_history())[0]
    for evaluation in evaluations:
        if evaluation.state in NON_TRADEABLE_STATES:
            assert evaluation.setup_score <= NON_TRADEABLE_SCORE_CAP


@given(feature_perturbation)
@settings(max_examples=150, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_score_components_always_sum_to_the_total(perturbation: tuple[float, float, float, float, str, bool]) -> None:
    snapshot = perturbed_snapshot(*perturbation)
    evaluations = StrategyEngine().evaluate(snapshot, five_minute_history())[0]
    for evaluation in evaluations:
        assert sum(evaluation.score_components.model_dump().values()) == evaluation.setup_score


@given(
    entry=st.floats(min_value=1, max_value=500, allow_nan=False),
    stop_offset=st.floats(min_value=-50, max_value=50, allow_nan=False),
)
@settings(max_examples=150, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_invalid_risk_geometry_never_awards_structure_points_and_never_crashes(entry: float, stop_offset: float) -> None:
    """A stop at or above entry is invalid geometry; the scorer must reject it, not misprice risk."""
    from app.scoring import _structure_contributions

    stop = entry + stop_offset
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    contributions = _structure_contributions(snapshot, entry, stop, rr=None)
    invalidation = next(value for value in contributions if value.key == "DISTANCE_TO_INVALIDATION")
    if stop >= entry:
        assert invalidation.points == 0
