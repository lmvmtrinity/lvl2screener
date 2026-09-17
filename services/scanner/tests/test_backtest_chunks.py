"""W8: the chunked backtest protocol must produce byte-identical results to a single-request
replay() call for the same sessions -- only the transport of the input changed, never the engine's
math. See app/backtest_chunks.py for the accumulator these tests exercise."""

from uuid import UUID

import pytest

from app.backtest import replay
from app.backtest_chunks import ChunkedBacktestAccumulator
from app.models import BacktestAssumptions, BacktestReplayChunkRequest, BacktestReplayRequest, BacktestSession
from test_feature_engine import daily_history, minute_history, quote, session
from test_strategy_engine import bar as strategy_bar

RUN_ID = UUID("10000000-0000-4000-8000-000000000001")
ASSUMPTIONS = BacktestAssumptions(starting_capital=100_000, position_size=10_000, slippage_bps=0, fee_per_trade=0)


def _session_with_a_ready_signal() -> BacktestSession:
    base = [
        strategy_bar(3, 99.5, 99.9, 99.4, 99.8, 100),
        strategy_bar(4, 99.7, 99.95, 99.6, 99.85, 100),
        strategy_bar(5, 99.8, 100, 99.7, 99.9, 100),
    ]
    breakout = strategy_bar(6, 99.9, 101.2, 99.8, 101, 250)
    captured_quote = quote().model_copy(update={"timestamp": breakout.end, "last": breakout.close, "day_high": breakout.high})
    return BacktestSession(session=session(), candles=[*daily_history(), *minute_history(), *base, breakout], quotes=[captured_quote])


def _chunk(session_payload: BacktestSession, is_final: bool) -> BacktestReplayChunkRequest:
    return BacktestReplayChunkRequest(
        chunk_id="chunked-run-1",
        run_id=RUN_ID,
        config_version="chunk-test",
        strategies=["HIGH_OF_DAY_BREAKOUT"],
        assumptions=ASSUMPTIONS,
        session=session_payload,
        is_final=is_final,
    )


def test_chunked_accumulation_matches_a_single_full_request_byte_for_byte() -> None:
    session_payload = _session_with_a_ready_signal()

    direct = replay(BacktestReplayRequest(
        run_id=RUN_ID, config_version="chunk-test", strategies=["HIGH_OF_DAY_BREAKOUT"],
        assumptions=ASSUMPTIONS, sessions=[session_payload, session_payload],
    ))

    accumulator = ChunkedBacktestAccumulator()
    intermediate = accumulator.add_chunk(_chunk(session_payload, is_final=False))
    assert intermediate is None  # only the final chunk triggers the engine

    chunked = accumulator.add_chunk(_chunk(session_payload, is_final=True))
    assert chunked is not None
    assert chunked.model_dump_json() == direct.model_dump_json()
    # Some signal actually ran through the engine, so this isn't a vacuously-equal empty result.
    assert any(value.state == "READY" for value in chunked.timeline)


def test_a_single_final_chunk_matches_a_single_session_full_request() -> None:
    session_payload = _session_with_a_ready_signal()
    direct = replay(BacktestReplayRequest(
        run_id=RUN_ID, config_version="chunk-test", strategies=["HIGH_OF_DAY_BREAKOUT"],
        assumptions=ASSUMPTIONS, sessions=[session_payload],
    ))
    accumulator = ChunkedBacktestAccumulator()
    chunked = accumulator.add_chunk(_chunk(session_payload, is_final=True))
    assert chunked is not None
    assert chunked.model_dump_json() == direct.model_dump_json()


def test_accumulator_entries_do_not_leak_across_different_chunk_ids() -> None:
    session_payload = _session_with_a_ready_signal()
    accumulator = ChunkedBacktestAccumulator()
    accumulator.add_chunk(_chunk(session_payload, is_final=False))
    # A different run (chunk_id) finalizing immediately must only see its own one session, not the
    # other in-progress run's accumulated session.
    other = BacktestReplayChunkRequest(
        chunk_id="chunked-run-2", run_id=RUN_ID, config_version="chunk-test",
        strategies=["HIGH_OF_DAY_BREAKOUT"], assumptions=ASSUMPTIONS, session=session_payload, is_final=True,
    )
    result = accumulator.add_chunk(other)
    assert result is not None
    assert result.data_quality.sessions == 1


def test_discard_drops_an_in_progress_run_without_running_the_engine() -> None:
    session_payload = _session_with_a_ready_signal()
    accumulator = ChunkedBacktestAccumulator()
    accumulator.add_chunk(_chunk(session_payload, is_final=False))
    accumulator.discard("chunked-run-1")
    # A finalize on the same chunk_id after a discard starts fresh (one session only), proving the
    # earlier accumulated session was actually dropped rather than silently kept.
    result = accumulator.add_chunk(_chunk(session_payload, is_final=True))
    assert result is not None
    assert result.data_quality.sessions == 1


def test_chunk_metadata_preserves_market_identity() -> None:
    payload = _chunk(_session_with_a_ready_signal(), is_final=False).model_copy(
        update={"market_id": "US_EQUITIES"}
    )
    assert payload.model_dump(by_alias=True)["marketId"] == "US_EQUITIES"
    accumulator = ChunkedBacktestAccumulator()
    accumulator.add_chunk(payload)
    assert accumulator._entries[payload.chunk_id].metadata["market_id"] == "US_EQUITIES"


def test_replay_rejects_market_mismatched_sessions() -> None:
    payload = _session_with_a_ready_signal()
    request = BacktestReplayRequest(
        run_id=RUN_ID,
        market_id="US_EQUITIES",
        config_version="chunk-test",
        strategies=["HIGH_OF_DAY_BREAKOUT"],
        assumptions=ASSUMPTIONS,
        sessions=[payload],
    )
    with pytest.raises(ValueError, match="does not match session market"):
        replay(request)
