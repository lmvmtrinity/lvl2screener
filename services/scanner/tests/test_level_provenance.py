from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from app.feature_engine import _confirmed_swings
from app.models import CandleRecord, FeatureLevel


def candles() -> list[CandleRecord]:
    start = datetime(2026, 9, 8, 14, 0, tzinfo=UTC)
    highs = [101, 102, 105, 103, 102]
    return [
        CandleRecord(
            instrument_id=UUID("11111111-1111-4111-8111-111111111111"),
            symbol="TEST.TO",
            timeframe="FiveMinutes",
            start=start + timedelta(minutes=5 * i),
            end=start + timedelta(minutes=5 * (i + 1)),
            open=100,
            high=high,
            low=99,
            close=100,
            volume=100,
            is_complete=True,
        )
        for i, high in enumerate(highs)
    ]


def test_swing_provenance_survives_json_without_changing_legacy_level_fields():
    bars = candles()
    level = _confirmed_swings(bars)[0][0]
    assert isinstance(level, FeatureLevel)
    assert level.provenance is not None
    assert level.provenance.origin_at == bars[2].end
    assert level.provenance.available_at == bars[4].end
    assert FeatureLevel.model_validate_json(level.model_dump_json()).provenance == level.provenance
    raw = level.model_dump(exclude={"provenance"})
    assert raw == {
        "price": 105.0,
        "type": "SWING_HIGH",
        "strength": pytest.approx(0.53),
        "tests": 1,
        "age_bars": 2,
    }
    assert FeatureLevel.model_validate(raw).provenance is None


def test_provenance_identity_survives_an_additional_bar():
    bars = candles()
    before = _confirmed_swings(bars)[0][0]
    later = bars[-1].model_copy(
        update={
            "start": bars[-1].end,
            "end": bars[-1].end + timedelta(minutes=5),
        }
    )
    after = _confirmed_swings([*bars, later])[0][0]
    assert before.provenance is not None
    assert after.provenance == before.provenance
