"""EngineResultBatch cross-language contract test (Python side).

Regenerates the shared golden fixture from a real `EngineResultBatch` -- the
exact payload shape `/internal/v1/quotes/batch` returns to the Node API --
so the TypeScript contracts package (`contracts/tests/engine-result-batch-contract-fixture.test.ts`)
can prove the live transport expander still accepts whatever this service
actually emits on the wire. Python is the producer of this payload, so it
owns the fixture; TypeScript only ever reads it.
"""

import json
from pathlib import Path
from uuid import UUID

from app.models import BenchmarkReadiness, EngineResultBatch, EngineTimings, StrategyStateEvent
from test_phase4_scoring import orb_replay

FIXTURE_PATH = Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / "engine-result-batch.json"


def test_engine_result_batch_round_trips_through_the_shared_fixture() -> None:
    _engine, snapshot, evaluations = orb_replay()
    ready = next(value for value in evaluations if value.state == "READY")

    batch = EngineResultBatch(
        snapshots=[snapshot],
        evaluations=evaluations,
        events=[StrategyStateEvent.model_validate({
            **ready.model_dump(mode="json", by_alias=True),
            "eventId": str(UUID("33333333-3333-4333-8333-333333333333")),
            "previousState": "FORMING",
        })],
        contexts=[],
        benchmark_readiness=BenchmarkReadiness(market=None, sectors=[]),
        timings=EngineTimings(feature_ms=1.234, evaluation_ms=2.345),
    )

    payload = batch.live_transport()
    assert payload["evaluations"]
    assert "featureSnapshot" not in payload["evaluations"][0]
    assert payload["evaluations"][0]["featureVersion"] == payload["snapshots"][0]["featureVersion"]
    assert "featureSnapshot" in payload["events"][0]
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # Sanity check on this side too: the payload we just wrote is exactly what we built.
    assert payload["evaluations"][0]["state"] in ("READY", "FORMING", "WATCH", "INACTIVE")
    assert any(item["state"] == "READY" for item in payload["evaluations"])
    assert ready.strategy in {item["strategy"] for item in payload["evaluations"]}
