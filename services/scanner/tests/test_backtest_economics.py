from app.backtest import _economically_viable
from app.models import BacktestEconomics

GATES = BacktestEconomics(min_net_reward_risk=1, min_stop_friction_multiple=2, min_target_friction_multiple=3, max_spread_pct=0.5)


def test_a_half_r_target_is_rejected() -> None:
    assert not _economically_viable(GATES, entry=100, stop=99, target=100.5, shares=10, slip=0.0002, fee=0, spread=0.02)


def test_a_two_r_target_with_room_passes() -> None:
    assert _economically_viable(GATES, entry=100, stop=99, target=102, shares=10, slip=0.0002, fee=0, spread=0.02)


def test_a_stop_inside_friction_is_rejected() -> None:
    assert not _economically_viable(GATES, entry=100, stop=99.95, target=101, shares=10, slip=0.0002, fee=0, spread=0.03)


def test_a_wide_spread_is_rejected() -> None:
    assert not _economically_viable(GATES, entry=100, stop=98, target=104, shares=10, slip=0.0002, fee=0, spread=0.6)
