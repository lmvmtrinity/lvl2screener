from app.models import StrategyParameters
from app.strategies.base import StrategyContext, StrategyMemory
from app.strategies.vwap_hold import VwapHoldStrategy
from app.strategies.vwap_reclaim import VwapReclaimStrategy
from test_feature_engine import quote, warmed_engine
from test_strategy_engine import bar


def test_completed_bar_vwap_drives_both_strategy_confirmations():
    snapshot = warmed_engine().ingest_quotes([quote()])[0]
    candles = [bar(4, 100, 100.2, 99.9, 100, 100), bar(5, 100.1, 100.6, 100.1, 100.5, 100)]
    for module in (VwapHoldStrategy(), VwapReclaimStrategy()):
        results = []
        for current_vwap in (100, 101):
            memory = StrategyMemory(state="FORMING", pullback_at=candles[0].end)
            current = snapshot.model_copy(update={"timestamp": candles[-1].end, "price": 102,
                                                   "vwap": current_vwap, "completed_bar_vwap": 100})
            results.append(module.next_state(memory, current, StrategyContext(bars=candles), StrategyParameters(), [])[0])
        assert results == ["READY", "READY"]
