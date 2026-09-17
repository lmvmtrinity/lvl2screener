"""Property test: context evaluations can never produce a trade event.

A long-standing design non-goal is that context (relative-strength) modules describe the
market, but only setup modules can transition state and emit `READY`. This
holds structurally today because `StrategyEngine.evaluate` builds `events`
only inside the setup loop and `contexts` in a separate loop over a disjoint
registry -- this test exercises many random profile mixes to keep that
separation from silently eroding as strategies are added.
"""

from uuid import UUID

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.models import ContextEvaluation, ScannerProfileConfig, StrategyEvaluation, StrategyStateEvent
from app.strategies import CONTEXT_REGISTRY, STRATEGY_REGISTRY
from app.strategy_engine import StrategyEngine
from test_feature_engine import five_minute_history, quote, warmed_engine

SETUP_KEYS = sorted(STRATEGY_REGISTRY.keys())
CONTEXT_KEYS = sorted(CONTEXT_REGISTRY.keys())

profile_mix = st.tuples(
    st.lists(st.sampled_from(SETUP_KEYS), min_size=0, max_size=len(SETUP_KEYS), unique=True),
    st.lists(st.sampled_from(CONTEXT_KEYS), min_size=0, max_size=len(CONTEXT_KEYS), unique=True),
)


def build_profiles(setup_keys: list[str], context_keys: list[str]) -> list[ScannerProfileConfig]:
    profiles = []
    for index, key in enumerate(setup_keys):
        module = STRATEGY_REGISTRY[key]
        profiles.append(ScannerProfileConfig(
            profile_id=UUID(int=index + 1), profile_name=f"Setup {key}", strategy=key,
            strategy_version=module.version, analysis_kind="SETUP", config_version="phase9-property", display_order=index,
        ))
    for index, key in enumerate(context_keys):
        module = CONTEXT_REGISTRY[key]
        profiles.append(ScannerProfileConfig(
            profile_id=UUID(int=1000 + index), profile_name=f"Context {key}", strategy=key,
            strategy_version=module.version, analysis_kind="CONTEXT", config_version="phase9-property", display_order=index,
        ))
    return profiles


@given(profile_mix)
@settings(max_examples=80, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_only_setup_profiles_can_produce_state_events(mix: tuple[list[str], list[str]]) -> None:
    setup_keys, context_keys = mix
    engine = StrategyEngine()
    engine.configure_profiles(build_profiles(setup_keys, context_keys))
    snapshot = warmed_engine().ingest_quotes([quote()])[0]

    evaluations, events, contexts = engine.evaluate(snapshot, five_minute_history())

    assert all(isinstance(value, StrategyEvaluation) for value in evaluations)
    assert all(isinstance(value, StrategyStateEvent) for value in events)
    assert all(isinstance(value, ContextEvaluation) for value in contexts)
    assert len(evaluations) == len(setup_keys)
    assert len(contexts) == len(context_keys)
    # Every event traces back to a setup-kind evaluation, never a context one.
    event_strategies = {value.strategy for value in events}
    assert event_strategies <= set(setup_keys)
    # No context evaluation carries a tradeable state or can be mistaken for one.
    for context in contexts:
        assert not hasattr(context, "state")
        assert context.signal in CONTEXT_REGISTRY
