import asyncio
from datetime import timedelta
from threading import Event

import pytest
from starlette.requests import Request

from app.backtest import replay_signals
from app.feature_engine import FeatureEngine
from app.models import BacktestAssumptions, BacktestReplayRequest, BacktestSession, QuoteRecord
from app.replay_cancellation import ReplayCancelled, run_cancellable_replay
from test_backtest import RUN_ID
from test_feature_engine import quote, session


class Connection:
    disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


@pytest.mark.parametrize("cancel_request", [False, True])
def test_disconnect_and_task_cancellation_join_the_worker(cancel_request: bool) -> None:
    async def scenario() -> None:
        connection = Connection()
        started = Event()
        stopped = Event()

        def operation(cancelled: Event) -> None:
            started.set()
            try:
                assert cancelled.wait(2), "Request left an abandoned replay worker"
                raise ReplayCancelled("stopped")
            finally:
                stopped.set()

        task = asyncio.create_task(run_cancellable_replay(connection, operation))
        assert await asyncio.to_thread(started.wait, 1)
        if cancel_request:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            connection.disconnected = True
            with pytest.raises(ReplayCancelled):
                await task
        assert stopped.is_set()

    asyncio.run(scenario())


def test_connected_request_preserves_result_and_failure() -> None:
    async def scenario() -> None:
        expected = object()
        assert await run_cancellable_replay(Connection(), lambda _: expected) is expected

        def fail(_: Event) -> None:
            raise ValueError("invalid retained evidence")

        with pytest.raises(ValueError, match="invalid retained evidence"):
            await run_cancellable_replay(Connection(), fail)

    asyncio.run(scenario())


def test_asgi_disconnect_stops_the_request_scoped_worker() -> None:
    async def disconnected():
        return {"type": "http.disconnect"}

    request = Request({"type": "http"}, receive=disconnected)
    stopped = Event()

    def operation(cancelled: Event) -> None:
        assert cancelled.wait(2)
        stopped.set()
        raise ReplayCancelled("disconnected")

    with pytest.raises(ReplayCancelled):
        asyncio.run(run_cancellable_replay(request, operation))
    assert stopped.is_set()


def test_signal_loop_stops_before_the_next_quote_without_returning_partial_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancelled = Event()
    calls = 0
    original = FeatureEngine.ingest_quotes

    def ingest(self: FeatureEngine, quotes: list[QuoteRecord], *, include_benchmark_features: bool = True):
        nonlocal calls
        calls += 1
        result = original(self, quotes, include_benchmark_features=include_benchmark_features)
        cancelled.set()
        return result

    monkeypatch.setattr(FeatureEngine, "ingest_quotes", ingest)
    first = quote()
    request = BacktestReplayRequest(
        run_id=RUN_ID,
        config_version="cancel-test",
        strategies=["ORB_RETEST"],
        assumptions=BacktestAssumptions(
            starting_capital=10000, position_size=1000, slippage_bps=0, fee_per_trade=0
        ),
        sessions=[BacktestSession(
            session=session(), candles=[],
            quotes=[first, first.model_copy(update={"timestamp": first.timestamp + timedelta(seconds=1)})],
        )],
    )
    with pytest.raises(ReplayCancelled):
        replay_signals(request, cancelled)
    assert calls == 1
