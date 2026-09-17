"""W8: in-memory accumulator for chunked backtest replays.

The Node worker used to send an entire backtest run (every market session) in one HTTP request,
which required Node to hold every session's quotes/candles in memory at once before sending. W8
replaces that with one request per market session; this module accumulates those sessions here,
keyed by an opaque `chunk_id` (the backtest run's id), and hands the accumulated list to the
existing, unmodified `replay()` engine exactly once -- when the chunk marked `is_final` arrives.

Because `replay()` itself is untouched and only ever sees a full `BacktestReplayRequest` built the
same way as the original single-request payload, results are identical to the old one-shot call;
only the transport of the input changed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from threading import Lock

from .backtest import replay
from .models import (
    BacktestReplayChunkRequest,
    BacktestReplayRequest,
    BacktestReplayResult,
    BacktestSession,
)

_DEFAULT_TTL_SECONDS = 30 * 60


@dataclass
class _Accumulator:
    metadata: dict[str, object]
    sessions: list[BacktestSession] = field(default_factory=list)
    last_touched: float = field(default_factory=time.monotonic)


class ChunkedBacktestAccumulator:
    """Holds in-progress chunked backtest runs. Not process-shared -- each scanner instance owns
    its own accumulator, so a chunked run must stay pinned to the scanner instance it started on
    for the duration of the run (true today: there is exactly one scanner instance).

    A worker that crashes mid-run leaves its entry orphaned (it never sends `is_final=True`).
    `_evict_stale`, run opportunistically on every call, drops entries untouched for longer than
    `ttl_seconds` so an abandoned run cannot leak memory here forever; the job's lease on the
    Node/Postgres side independently notices the crash and retries with a fresh run id (and thus a
    fresh `chunk_id`), so evicting here never loses data a retry needs.
    """

    def __init__(self, ttl_seconds: float = _DEFAULT_TTL_SECONDS) -> None:
        self._entries: dict[str, _Accumulator] = {}
        self._lock = Lock()
        self._ttl_seconds = ttl_seconds

    def add_chunk(self, request: BacktestReplayChunkRequest) -> BacktestReplayResult | None:
        with self._lock:
            self._evict_stale()
            entry = self._entries.get(request.chunk_id)
            if entry is None:
                entry = _Accumulator(
                    metadata={
                        "run_id": request.run_id,
                        "market_id": request.market_id,
                        "config_version": request.config_version,
                        "strategies": request.strategies,
                        "parameters": request.parameters,
                        "assumptions": request.assumptions,
                    },
                )
                self._entries[request.chunk_id] = entry
            entry.sessions.append(request.session)
            entry.last_touched = time.monotonic()
            if not request.is_final:
                return None
            full_request = BacktestReplayRequest(sessions=entry.sessions, **entry.metadata)
            del self._entries[request.chunk_id]
        # replay() is a pure function of the assembled request; run it outside the lock.
        return replay(full_request)

    def discard(self, chunk_id: str) -> None:
        """Drops an in-progress run's accumulated sessions, e.g. after the worker observes a
        cancellation request and stops sending further chunks."""
        with self._lock:
            self._entries.pop(chunk_id, None)

    def _evict_stale(self) -> None:
        cutoff = time.monotonic() - self._ttl_seconds
        stale = [key for key, value in self._entries.items() if value.last_touched < cutoff]
        for key in stale:
            del self._entries[key]
