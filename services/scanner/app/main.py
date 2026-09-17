from contextlib import asynccontextmanager
import asyncio
from datetime import UTC, datetime
from time import perf_counter
from collections.abc import AsyncIterator

from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from starlette.responses import JSONResponse

from .backtest import replay, replay_signals
from .backtest_chunks import ChunkedBacktestAccumulator
from .replay_cancellation import run_cancellable_replay
from .statistical_models import predict as predict_statistical, train as train_statistical
from .funded_execution_models import (
    FundedExecutionInferenceOutput,
    FundedExecutionInferenceRequest,
    FundedExecutionTrainingRequest,
    FundedExecutionTrainingResult,
)
from .funded_execution_models import predict as predict_funded_execution
from .funded_execution_models import train as train_funded_execution
from .config import ScannerConfig, load_config
from .discovery import evaluate_discovery
from .discovery_models import DiscoveryInput, DiscoveryResult
from .feature_engine import FeatureEngine
from .logging_config import configure_logging
from .models import (
    CandleBatch,
    InstrumentWarmup,
    InstrumentWarmupReadiness,
    BacktestReplayChunkRequest,
    BacktestReplayRequest,
    BacktestReplayResult,
    BacktestSignalReplayResult,
    FeatureSnapshot,
    EngineResultBatch,
    EngineTimings,
    FeatureSnapshotBatch,
    QuoteBatch,
    ScannerProfileBatch,
    ScannerProfileConfig,
    ScannerChecks,
    ScannerReadiness,
    ServiceHealth,
    SessionStart,
    StatisticalPredictionBatch,
    StatisticalPredictionRequest,
    StatisticalTrainingRequest,
    StatisticalTrainingResult,
)


def create_app(config: ScannerConfig | None = None, engine: FeatureEngine | None = None) -> FastAPI:
    resolved_config = config or load_config()
    logger = configure_logging(resolved_config.log_level)
    # Each market owns an engine with isolated instruments, candles, quotes,
    # benchmarks, strategy state, and session clock. The injected engine keeps
    # the existing TSX-focused test seam intact.
    feature_engines: dict[str, FeatureEngine] = {"CA_TSX": engine or FeatureEngine()}
    profiles: list[ScannerProfileConfig] = []
    chunked_backtests = ChunkedBacktestAccumulator()

    def feature_engine_for(market_id: str) -> FeatureEngine:
        value = feature_engines.get(market_id)
        if value is None:
            value = FeatureEngine()
            value.strategies.configure_profiles([profile for profile in profiles if profile.market_id == market_id])
            feature_engines[market_id] = value
        return value

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info("Scanner service started", extra={"event": "SCANNER_READY"})
        yield
        logger.info("Scanner service stopped", extra={"event": "SCANNER_STOPPED"})

    application = FastAPI(
        title="TSX Scanner Engine",
        version=resolved_config.version,
        lifespan=lifespan,
    )

    # W5: internal shared-credential boundary between the api/worker and this service. /health/*
    # stays open (container healthchecks call it with no credential), but every /internal/v1/*
    # route -- the ones that can mutate engine state or run a backtest -- rejects requests that
    # don't present the matching X-Scanner-Token header, once an operator has set
    # SCANNER_SERVICE_TOKEN. Enforced at the middleware layer rather than per-route so a newly
    # added /internal/v1/* route is covered automatically.
    @application.middleware("http")
    async def enforce_scanner_service_token(request: Request, call_next):
        if resolved_config.service_token and request.url.path.startswith("/internal/"):
            presented = request.headers.get("x-scanner-token")
            if presented != resolved_config.service_token:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Missing or invalid scanner service credential"},
                )
        return await call_next(request)

    @application.post("/internal/v1/system/runtime-identity")
    async def research_runtime_identity() -> dict[str, object]:
        from .runtime_identity import runtime_identity
        return runtime_identity()

    @application.get("/health/live", response_model=ServiceHealth)
    async def live() -> ServiceHealth:
        return ServiceHealth(
            service="scanner",
            status="ok",
            version=resolved_config.version,
            timestamp=datetime.now(UTC),
        )

    @application.get("/health/ready", response_model=ScannerReadiness)
    async def ready() -> ScannerReadiness:
        return ScannerReadiness(
            service="scanner",
            status="ok",
            version=resolved_config.version,
            timestamp=datetime.now(UTC),
            checks=ScannerChecks(config="ok", feature_engine="ok"),
        )

    @application.post("/internal/v1/discovery/evaluate", response_model=DiscoveryResult)
    async def discovery_evaluate(payload: DiscoveryInput) -> DiscoveryResult:
        return evaluate_discovery(payload)

    @application.post("/internal/v1/session/start", status_code=204)
    async def start_session(session: SessionStart) -> None:
        try:
            feature_engine_for(session.market_id).start_session(session)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @application.put("/internal/v1/profiles", status_code=204)
    async def configure_profiles(batch: ScannerProfileBatch) -> None:
        try:
            profiles[:] = batch.profiles
            for market_id, value in feature_engines.items():
                value.strategies.configure_profiles(
                    [profile for profile in batch.profiles if profile.market_id == market_id]
                )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @application.post("/internal/v1/candles/batch", status_code=204)
    async def ingest_candles(batch: CandleBatch) -> None:
        try:
            feature_engine_for(batch.market_id).ingest_candles(batch.candles)
        except (RuntimeError, ValueError) as error:
            status = 409 if isinstance(error, RuntimeError) else 400
            raise HTTPException(status_code=status, detail=str(error)) from error

    @application.post("/internal/v1/instruments/warm", response_model=InstrumentWarmupReadiness)
    async def warm_instrument(payload: InstrumentWarmup) -> InstrumentWarmupReadiness:
        try:
            return feature_engine_for(payload.market_id).warm_instrument(
                payload.instrument, payload.candles, payload.as_of
            )
        except (RuntimeError, ValueError) as error:
            status = 409 if isinstance(error, RuntimeError) else 400
            raise HTTPException(status_code=status, detail=str(error)) from error

    @application.post("/internal/v1/quotes/batch", response_model=EngineResultBatch)
    async def ingest_quotes(batch: QuoteBatch) -> EngineResultBatch:
        try:
            feature_engine = feature_engine_for(batch.market_id)
            feature_started = perf_counter()
            snapshots = feature_engine.ingest_quotes(batch.quotes)
            candidates = [snapshot for snapshot in snapshots if feature_engine.is_candidate(snapshot.instrument_id)]
            feature_ms = (perf_counter() - feature_started) * 1_000
            evaluations = []
            events = []
            contexts = []
            evaluation_started = perf_counter()
            for snapshot in candidates:
                current, changed, current_contexts = feature_engine.strategies.evaluate(
                    snapshot, feature_engine.strategy_context(snapshot)
                )
                evaluations.extend(current)
                events.extend(changed)
                contexts.extend(current_contexts)
            evaluation_ms = (perf_counter() - evaluation_started) * 1_000
            return EngineResultBatch(
                snapshots=candidates,
                evaluations=evaluations,
                events=events,
                contexts=contexts,
                benchmark_readiness=feature_engine.benchmark_readiness(),
                timings=EngineTimings(feature_ms=round(feature_ms, 3), evaluation_ms=round(evaluation_ms, 3)),
            )
        except (RuntimeError, ValueError) as error:
            status = 409 if isinstance(error, RuntimeError) else 400
            raise HTTPException(status_code=status, detail=str(error)) from error

    @application.get("/internal/v1/candidates", response_model=FeatureSnapshotBatch)
    async def candidates(marketId: str = "CA_TSX") -> FeatureSnapshotBatch:
        feature_engine = feature_engine_for(marketId)
        return FeatureSnapshotBatch(
            snapshots=[
                value for value in feature_engine.snapshots() if feature_engine.is_candidate(value.instrument_id)
            ]
        )

    @application.get("/internal/v1/symbol/{instrument_id}/features", response_model=FeatureSnapshot)
    async def features(instrument_id: UUID, marketId: str = "CA_TSX") -> FeatureSnapshot:
        feature_engine = feature_engine_for(marketId)
        snapshot = feature_engine.snapshot(instrument_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="No feature snapshot for instrument")
        return snapshot

    @application.post("/internal/v1/backtests", response_model=BacktestReplayResult)
    async def run_backtest(request: BacktestReplayRequest) -> BacktestReplayResult:
        try:
            return await asyncio.to_thread(replay, request)
        except (RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post(
        "/internal/v1/backtests/signals",
        response_model=BacktestSignalReplayResult,
    )
    async def run_backtest_signals(
        request: BacktestReplayRequest, http_request: Request
    ) -> BacktestSignalReplayResult:
        try:
            return await run_cancellable_replay(http_request, lambda cancelled: replay_signals(request, cancelled))
        except (RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post(
        "/internal/v1/backtests/signals/chunk",
        response_model=BacktestSignalReplayResult,
    )
    async def run_backtest_signal_chunk(
        request: BacktestReplayChunkRequest, http_request: Request
    ) -> BacktestSignalReplayResult:
        full_request = BacktestReplayRequest(
            run_id=request.run_id,
            market_id=request.market_id,
            config_version=request.config_version,
            strategies=request.strategies,
            parameters=request.parameters,
            assumptions=request.assumptions,
            sessions=[request.session],
        )
        try:
            return await run_cancellable_replay(http_request, lambda cancelled: replay_signals(full_request, cancelled))
        except (RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post(
        "/internal/v1/backtests/chunk",
        status_code=200,
        response_model=BacktestReplayResult | None,
    )
    async def run_backtest_chunk(request: BacktestReplayChunkRequest) -> BacktestReplayResult | None:
        # W8: one session per call so the caller can persist progress/heartbeat and check
        # cancellation between sessions instead of holding one long request open. Accumulation and
        # the final replay() call share one lock inside chunked_backtests, so this is safe to
        # `await` from concurrent requests for different chunk_ids.
        try:
            return await asyncio.to_thread(chunked_backtests.add_chunk, request)
        except (RuntimeError, ValueError) as error:
            chunked_backtests.discard(request.chunk_id)
            raise HTTPException(status_code=422, detail=str(error)) from error

    @application.post("/internal/v1/statistical-models/train", response_model=StatisticalTrainingResult)
    async def train_statistical_model(request: StatisticalTrainingRequest) -> StatisticalTrainingResult:
        return await asyncio.to_thread(train_statistical, request)

    @application.post("/internal/v1/statistical-models/predict", response_model=StatisticalPredictionBatch)
    async def predict_statistical_model(request: StatisticalPredictionRequest) -> StatisticalPredictionBatch:
        return StatisticalPredictionBatch(
            predictions=[predict_statistical(request.artifact, value) for value in request.inputs]
        )

    # FP02: funded-execution learning is a separate domain from the signal-quality
    # statistical models above. These endpoints remain diagnostic only: they never
    # return an order action and are not wired into funded execution.
    @application.post("/internal/v1/funded-execution-models/train", response_model=FundedExecutionTrainingResult)
    async def train_funded_execution_model(request: FundedExecutionTrainingRequest) -> FundedExecutionTrainingResult:
        return await asyncio.to_thread(train_funded_execution, request)

    @application.post("/internal/v1/funded-execution-models/predict", response_model=FundedExecutionInferenceOutput)
    async def predict_funded_execution_model(request: FundedExecutionInferenceRequest) -> FundedExecutionInferenceOutput:
        return await asyncio.to_thread(predict_funded_execution, request)

    return application


app = create_app()
