"""Cooperative cancellation for CPU-bound, request-scoped signal replay."""

import asyncio
from collections.abc import Callable
from threading import Event
from typing import Protocol, TypeVar


class ReplayCancelled(RuntimeError):
    pass


class DisconnectProbe(Protocol):
    async def is_disconnected(self) -> bool: ...


Result = TypeVar("Result")


async def run_cancellable_replay(
    request: DisconnectProbe, operation: Callable[[Event], Result]
) -> Result:
    cancelled = Event()
    work = asyncio.create_task(asyncio.to_thread(operation, cancelled))
    try:
        while not work.done():
            if await request.is_disconnected():
                cancelled.set()
            await asyncio.wait({work}, timeout=0.1)
        result = await work
        if cancelled.is_set():
            raise ReplayCancelled("Signal replay client disconnected")
        return result
    finally:
        # Cancelling the asyncio task alone does not stop its worker thread.
        # Signal the quote loop and join it before releasing request resources.
        cancelled.set()
        try:
            await asyncio.shield(work)
        except Exception:
            # The normal await above propagates operation errors. During request
            # cancellation preserve CancelledError after consuming the worker error.
            pass
