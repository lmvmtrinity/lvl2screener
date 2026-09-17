from typing import cast

from .base import StrategyModule
from .bull_flag import BullFlagStrategy
from .high_of_day_breakout import HighOfDayBreakoutStrategy
from .orb_retest import OrbRetestStrategy
from .prior_day_high_breakout import PriorDayHighBreakoutStrategy
from .rsi_vwap_reclaim import RsiVwapReclaimStrategy
from .relative_strength import ContextSignalModule, MarketRelativeStrengthSignal, SectorRelativeStrengthSignal
from .vwap_hold import VwapHoldStrategy
from .vwap_reclaim import VwapReclaimStrategy


_MODULES: tuple[StrategyModule, ...] = (
    cast(StrategyModule, OrbRetestStrategy()),
    cast(StrategyModule, VwapHoldStrategy()),
    cast(StrategyModule, VwapReclaimStrategy()),
    cast(StrategyModule, RsiVwapReclaimStrategy()),
    cast(StrategyModule, HighOfDayBreakoutStrategy()),
    cast(StrategyModule, BullFlagStrategy()),
    cast(StrategyModule, PriorDayHighBreakoutStrategy()),
)

STRATEGY_REGISTRY: dict[str, StrategyModule] = {module.key: module for module in _MODULES}
_CONTEXT_MODULES: tuple[ContextSignalModule, ...] = (
    cast(ContextSignalModule, SectorRelativeStrengthSignal),
    cast(ContextSignalModule, MarketRelativeStrengthSignal),
)
CONTEXT_REGISTRY: dict[str, ContextSignalModule] = {module.key: module for module in _CONTEXT_MODULES}
