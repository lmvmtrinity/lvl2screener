from uuid import UUID

from app.models import ScannerProfileConfig
from app.strategies.base import BenchmarkObservation, StrategyContext
from app.scoring import SCORE_VERSION
from app.strategy_engine import StrategyEngine
from test_feature_engine import five_minute_history, quote, warmed_engine


ANALYSES = [
    "ORB_RETEST", "VWAP_HOLD", "VWAP_RECLAIM", "RSI_VWAP_RECLAIM", "HIGH_OF_DAY_BREAKOUT", "BULL_FLAG",
    "PRIOR_DAY_HIGH_BREAKOUT", "SECTOR_RELATIVE_STRENGTH", "MARKET_RELATIVE_STRENGTH",
]


def test_all_analysis_modules_match_the_phase_0_golden_contract() -> None:
    profiles = [ScannerProfileConfig(
        profile_id=UUID(int=index + 1), profile_name=name, strategy=name,
        analysis_kind="CONTEXT" if "RELATIVE_STRENGTH" in name else "SETUP",
        config_version="phase0-golden-v1",
    ) for index, name in enumerate(ANALYSES)]
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    context = StrategyContext(
        bars=five_minute_history(), prior_day_high=113, sector="Materials",
        sector_benchmark=BenchmarkObservation("XMA.TO", .2, snapshot.timestamp, "REALTIME", True),
        market_benchmark=BenchmarkObservation("XIU.TO", .1, snapshot.timestamp, "REALTIME", True),
    )
    engine = StrategyEngine()
    engine.configure_profiles(profiles)

    setups, _events, contexts = engine.evaluate(snapshot, context)

    # Phase 4 re-baselined the golden scores: the single additive score was replaced
    # with strategy-owned components, so identical states no longer share one score.
    assert [(value.strategy, value.state, value.setup_score) for value in setups] == [
        ("ORB_RETEST", "WATCH", 30),
        ("VWAP_HOLD", "WATCH", 31),
        ("VWAP_RECLAIM", "WATCH", 23),
        ("RSI_VWAP_RECLAIM", "INACTIVE", 23),
        ("HIGH_OF_DAY_BREAKOUT", "WATCH", 23),
        ("BULL_FLAG", "WATCH", 23),
        ("PRIOR_DAY_HIGH_BREAKOUT", "WATCH", 23),
    ]
    assert all(value.score_version == SCORE_VERSION for value in setups)
    assert all(sum(value.score_components.model_dump().values()) == value.setup_score for value in setups)
    assert [(value.signal, value.status, value.context_score) for value in contexts] == [
        ("SECTOR_RELATIVE_STRENGTH", "STRONG", 85),
        ("MARKET_RELATIVE_STRENGTH", "STRONG", 90),
    ]
    assert all(value.kind == "SETUP" for value in setups)
    assert all(value.kind == "CONTEXT" and not hasattr(value, "entry_reference") for value in contexts)
