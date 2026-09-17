import {
  backtestReplayResultSchema,
  backtestSignalReplayResultSchema,
  engineResultBatchSchema,
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
  fundedExecutionInferenceOutputSchema,
  fundedExecutionTrainingResultSchema,
  type DiscoveryEvaluationInput,
  type DiscoveryEvaluationResult,
  statisticalPredictionBatchSchema,
  statisticalTrainingResultSchema,
  type BacktestReplayResult,
  type BacktestSignalReplayResult,
  type EngineResultBatch,
  type FundedExecutionInferenceOutput,
  type FundedExecutionTrainingResult,
  type ScannerProfile,
  type StatisticalPredictionBatch,
  type StatisticalTrainingResult,
  type MarketId,
} from "@tsx-scanner/contracts";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import type { Candle, Market, Quote } from "../questrade/types.js";
import type { PersistedInstrument } from "./repository.js";
import type { SessionPolicy } from "./session-manager.js";
import type { BenchmarkSnapshot } from "./benchmark-service.js";

export interface WarmupReadiness {
  instrumentId: string;
  ready: boolean;
  dailyHistoryCount: number;
  historicalIntradaySessionCount: number;
  currentSessionOneMinuteCount: number;
  openingRangeComplete: boolean;
  benchmarkReady: boolean;
  reasons: string[];
}

const warmupReadinessSchema = z
  .object({
    instrumentId: z.string().uuid(),
    ready: z.boolean(),
    dailyHistoryCount: z.number().int().nonnegative(),
    historicalIntradaySessionCount: z.number().int().nonnegative(),
    currentSessionOneMinuteCount: z.number().int().nonnegative(),
    openingRangeComplete: z.boolean(),
    benchmarkReady: z.boolean(),
    reasons: z.array(z.string().min(1)),
  })
  .strict();

// Captured-history replay is intentionally slower than live feature requests: a single US
// session can contain thousands of quote snapshots plus benchmark/context streams. Keep the
// normal client timeout for live paths, but allow research-only replay endpoints enough time to
// finish without manufacturing an incomplete result.
const BACKTEST_REQUEST_TIMEOUT_MS = 600_000;
// Historical warm-up can contain hundreds of thousands of candles. Bound each
// upload so validation/ingestion fits the live request deadline during recovery.
const CANDLE_BATCH_SIZE = 5_000;

export interface FeatureEngineSink {
  startSession(
    market: Market,
    instruments: PersistedInstrument[],
    policy: SessionPolicy,
    benchmarks?: BenchmarkSnapshot,
    benchmarkMaxStalenessSeconds?: number,
    marketId?: MarketId,
  ): Promise<void>;
  ingestCandles(
    candles: Candle[],
    instruments: PersistedInstrument[],
    marketId?: MarketId,
  ): Promise<void>;
  warmInstrument?(
    instrument: PersistedInstrument,
    candles: Candle[],
    marketId?: MarketId,
  ): Promise<WarmupReadiness>;
  ingestQuotes(
    quotes: Quote[],
    instruments: PersistedInstrument[],
    marketId?: MarketId,
  ): Promise<EngineResultBatch>;
}

export class ScannerFeatureClient implements FeatureEngineSink {
  private profiles: ScannerProfile[] = [];
  constructor(
    private readonly scannerUrl: URL,
    private readonly timeoutMs = 10_000,
    // W5: shared internal credential presented to the scanner's /internal/v1/* routes. The
    // scanner rejects mismatched/missing tokens once its own SCANNER_SERVICE_TOKEN is set (see
    // services/scanner/app/main.py), so this is the boundary an in-network attacker (or a host
    // process reaching a debug-profile scanner port) still has to clear.
    private readonly serviceToken?: string,
  ) {}

  async researchRuntimeIdentity(): Promise<unknown> {
    return this.post("/internal/v1/system/runtime-identity", {});
  }

  setProfiles(profiles: ScannerProfile[]): void {
    this.profiles = profiles.filter((value) => value.enabled);
  }

  async evaluateDiscovery(
    value: DiscoveryEvaluationInput,
  ): Promise<DiscoveryEvaluationResult> {
    const input = discoveryEvaluationInputSchema.parse(value);
    const result = discoveryEvaluationResultSchema.parse(
      await this.post("/internal/v1/discovery/evaluate", input),
    );
    if (
      result.marketId !== input.marketId ||
      result.policyVersion !== input.policyVersion ||
      result.providerCode !== input.providerCode ||
      result.providerExchange !== input.providerExchange ||
      result.symbolId !== input.identity.symbolId ||
      result.tradingDate !== input.tradingDate ||
      Date.parse(result.evaluationAt) !== Date.parse(input.evaluationAt) ||
      Date.parse(result.completedBarEnd) !== Date.parse(input.completedBarEnd)
    )
      throw new Error("Scanner discovery result ownership mismatch");
    return result;
  }
  async syncProfiles(profiles: ScannerProfile[]): Promise<void> {
    this.setProfiles(profiles);
    const response = await fetch(
      new URL("/internal/v1/profiles", this.scannerUrl),
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(this.serviceToken
            ? { "x-scanner-token": this.serviceToken }
            : {}),
        },
        body: JSON.stringify({ profiles: this.profilePayload() }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok)
      throw new Error(
        `Scanner /internal/v1/profiles returned HTTP ${response.status}`,
      );
  }

  private profilePayload(marketId?: MarketId) {
    return this.profiles
      .filter((profile) => !marketId || profile.marketId === marketId)
      .map((profile) => ({
        profileId: profile.id,
        profileName: profile.name,
        marketId: profile.marketId,
        strategy: profile.strategyKey,
        analysisKind: profile.analysisKind,
        strategyVersion: profile.strategyVersion,
        configVersion: profile.configVersion,
        parameters: profile.parameters,
        enabled: profile.enabled,
        displayOrder: profile.displayOrder,
      }));
  }

  async startSession(
    market: Market,
    instruments: PersistedInstrument[],
    policy: SessionPolicy,
    benchmarks?: BenchmarkSnapshot,
    benchmarkMaxStalenessSeconds = 30,
    marketId?: MarketId,
  ): Promise<void> {
    const resolvedMarketId = marketIdFor(instruments, marketId);
    const benchmarkInstruments = (benchmarks?.references ?? []).flatMap(
      (reference) =>
        reference.instrument
          ? [
              {
                instrumentId: reference.instrument.id,
                symbol: reference.instrument.symbol,
                sector: null,
                role: "BENCHMARK",
                benchmarkKind: reference.kind,
                benchmarkSector: reference.sector,
              },
            ]
          : [],
    );
    await this.post("/internal/v1/session/start", {
      marketId: resolvedMarketId,
      market: market.name,
      timezone: policy.timezone,
      startTime: market.startTime.toISOString(),
      endTime: market.endTime.toISOString(),
      openingRange: policy.openingRange,
      scanning: policy.scanning,
      entries: policy.entries,
      instruments: [
        ...instruments.map((instrument) => ({
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          sector: instrument.sector,
          role: "CANDIDATE",
        })),
        ...benchmarkInstruments,
      ],
      benchmarks: (benchmarks?.references ?? []).map((reference) => ({
        kind: reference.kind,
        symbol: reference.symbol,
        sector: reference.sector,
      })),
      benchmarkMaxStalenessSeconds,
      profiles: this.profilePayload(resolvedMarketId),
    });
  }

  async ingestCandles(
    candles: Candle[],
    instruments: PersistedInstrument[],
    marketId?: MarketId,
  ): Promise<void> {
    const bySymbolId = new Map(
      instruments.map((instrument) => [instrument.symbolId, instrument]),
    );
    const resolvedMarketId = marketIdFor(instruments, marketId);
    const payload = candles.map((candle) => {
      const instrument = bySymbolId.get(candle.symbolId);
      if (!instrument)
        throw new Error(
          `No enriched instrument for Questrade symbol ID ${candle.symbolId}`,
        );
      return {
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        timeframe: candle.interval,
        start: candle.start.toISOString(),
        end: candle.end.toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        isComplete: candle.isComplete,
      };
    });
    for (let offset = 0; offset < payload.length; offset += CANDLE_BATCH_SIZE) {
      await this.post("/internal/v1/candles/batch", {
        marketId: resolvedMarketId,
        candles: payload.slice(offset, offset + CANDLE_BATCH_SIZE),
      });
    }
  }

  async warmInstrument(
    instrument: PersistedInstrument,
    candles: Candle[],
    marketId?: MarketId,
  ): Promise<WarmupReadiness> {
    const payload = candles.map((candle) => {
      if (candle.symbolId !== instrument.symbolId)
        throw new Error(
          `Discovery warm-up candle does not belong to ${instrument.symbol}`,
        );
      return {
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        timeframe: candle.interval,
        start: candle.start.toISOString(),
        end: candle.end.toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        isComplete: candle.isComplete,
      };
    });
    return warmupReadinessSchema.parse(
      await this.post("/internal/v1/instruments/warm", {
        marketId: marketIdFor([instrument], marketId),
        instrument: {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          sector: instrument.sector,
          role: "CANDIDATE",
        },
        candles: payload,
        asOf: new Date().toISOString(),
      }),
    );
  }

  async ingestQuotes(
    quotes: Quote[],
    instruments: PersistedInstrument[],
    marketId?: MarketId,
  ): Promise<EngineResultBatch> {
    const bySymbolId = new Map(
      instruments.map((instrument) => [instrument.symbolId, instrument]),
    );
    const response = await this.post("/internal/v1/quotes/batch", {
      marketId: marketIdFor(instruments, marketId),
      quotes: quotes.map((quote) => {
        const instrument = bySymbolId.get(quote.symbolId);
        if (!instrument)
          throw new Error(
            `No enriched instrument for Questrade symbol ID ${quote.symbolId}`,
          );
        return {
          instrumentId: instrument.id,
          symbol: quote.symbol,
          timestamp: quote.receivedAt.toISOString(),
          bid: quote.bid,
          ask: quote.ask,
          bidSize: quote.bidSize,
          askSize: quote.askSize,
          spread: quote.spreadAbsolute,
          last: quote.last,
          dayOpen: quote.dayOpen,
          dayHigh: quote.dayHigh,
          dayLow: quote.dayLow,
          volume: quote.volume,
          dataStatus: quote.dataStatus,
          actionable: quote.actionable,
          delaySeconds: quote.delaySeconds,
        };
      }),
    });
    return engineResultBatchSchema.parse(response);
  }

  async runBacktest(payload: unknown): Promise<BacktestReplayResult> {
    return backtestReplayResultSchema.parse(
      await this.post("/internal/v1/backtests", payload, 120_000),
    );
  }

  async runBacktestSignals(
    payload: unknown,
  ): Promise<BacktestSignalReplayResult> {
    return backtestSignalReplayResultSchema.parse(
      await this.post(
        "/internal/v1/backtests/signals",
        payload,
        BACKTEST_REQUEST_TIMEOUT_MS,
      ),
    );
  }

  async runBacktestSignalChunk(
    chunkId: string,
    runMetadata: Record<string, unknown>,
    session: Record<string, unknown>,
    isFinal: boolean,
    signal?: AbortSignal,
  ): Promise<BacktestSignalReplayResult> {
    return backtestSignalReplayResultSchema.parse(
      await this.post(
        "/internal/v1/backtests/signals/chunk",
        { chunkId, ...runMetadata, session, isFinal },
        BACKTEST_REQUEST_TIMEOUT_MS,
        signal,
      ),
    );
  }

  /** W8: chunked counterpart to {@link runBacktest}. The worker calls this once per Toronto
   * session instead of sending the whole run in one request, so it can persist progress/heartbeat
   * and observe cancellation between sessions. The scanner service accumulates sessions in memory
   * keyed by `chunkId` and only runs the (unchanged) replay engine once the final chunk arrives,
   * so results are identical to a single `runBacktest` call with all sessions -- this only changes
   * how the input is delivered, not the math. Returns the final result on the chunk where
   * `isFinal` is true, `undefined` otherwise. */
  async runBacktestChunk(
    chunkId: string,
    runMetadata: Record<string, unknown>,
    session: Record<string, unknown>,
    isFinal: boolean,
  ): Promise<BacktestReplayResult | undefined> {
    const response = await this.post(
      "/internal/v1/backtests/chunk",
      { chunkId, ...runMetadata, session, isFinal },
      BACKTEST_REQUEST_TIMEOUT_MS,
    );
    if (!isFinal) return undefined;
    return backtestReplayResultSchema.parse(response);
  }

  async trainStatistical(payload: unknown): Promise<StatisticalTrainingResult> {
    return statisticalTrainingResultSchema.parse(
      await this.post(
        "/internal/v1/statistical-models/train",
        payload,
        120_000,
      ),
    );
  }
  async predictStatistical(
    payload: unknown,
    requestSignal?: AbortSignal,
  ): Promise<StatisticalPredictionBatch> {
    return statisticalPredictionBatchSchema.parse(
      await this.post(
        "/internal/v1/statistical-models/predict",
        payload,
        this.timeoutMs,
        requestSignal,
      ),
    );
  }

  /** FP02: funded-execution learning is a separate diagnostic domain. */
  async trainFundedExecution(
    payload: unknown,
  ): Promise<FundedExecutionTrainingResult> {
    return fundedExecutionTrainingResultSchema.parse(
      await this.post(
        "/internal/v1/funded-execution-models/train",
        payload,
        120_000,
      ),
    );
  }
  async predictFundedExecution(
    payload: unknown,
    requestSignal?: AbortSignal,
  ): Promise<FundedExecutionInferenceOutput> {
    return fundedExecutionInferenceOutputSchema.parse(
      await this.post(
        "/internal/v1/funded-execution-models/predict",
        payload,
        this.timeoutMs,
        requestSignal,
      ),
    );
  }

  private async post(
    path: string,
    body: unknown,
    timeoutMs = this.timeoutMs,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, timeoutSignal])
      : timeoutSignal;
    // Undici's default 300 s response-header timeout aborts research replays
    // that legitimately run longer than five minutes. Route those calls
    // through node:http, where the configured AbortSignal is the only
    // deadline, instead of extending short live-path requests.
    if (timeoutMs >= 300_000) return this.postLongRunning(path, body, signal);
    const response = await fetch(new URL(path, this.scannerUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.serviceToken ? { "x-scanner-token": this.serviceToken } : {}),
      },
      body: JSON.stringify(body),
      signal,
    }).catch((error: unknown) => {
      throw new Error(
        `Scanner ${path} request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
    if (!response.ok) {
      const detail = await response
        .json()
        .then(scannerErrorDetail)
        .catch(() => undefined);
      throw scannerHttpError(path, response.status, detail);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  private postLongRunning(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path, this.scannerUrl);
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = transport(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            ...(this.serviceToken
              ? { "x-scanner-token": this.serviceToken }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const body = Buffer.concat(chunks).toString("utf8");
              let detail: string | undefined;
              try {
                detail = scannerErrorDetail(JSON.parse(body));
              } catch {
                detail = undefined;
              }
              reject(scannerHttpError(path, status, detail));
              return;
            }
            if (status === 204) {
              resolve(undefined);
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new Error(`Scanner ${path} returned invalid JSON`));
            }
          });
        },
      );
      const abort = () => request.destroy(new Error("request aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      request.on("error", (error) =>
        reject(
          new Error(`Scanner ${path} request failed: ${error.message}`, {
            cause: error,
          }),
        ),
      );
      request.end(payload);
    });
  }
}

function scannerErrorDetail(payload: unknown): string | undefined {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("detail" in payload)
  ) {
    return undefined;
  }
  const detail = payload.detail;
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

function scannerHttpError(
  path: string,
  status: number,
  detail?: string,
): Error {
  return new Error(
    `Scanner ${path} returned HTTP ${status}${detail === undefined ? "" : `: ${detail}`}`,
  );
}

function marketIdFor(
  instruments: readonly PersistedInstrument[],
  marketId?: MarketId,
): MarketId {
  const values = new Set(
    instruments.map((instrument) => instrument.marketId ?? "CA_TSX"),
  );
  if (values.size === 0) {
    return marketId ?? "CA_TSX";
  }
  if (values.size > 1) {
    throw new Error("A scanner batch must contain exactly one market");
  }
  const detected = values.values().next().value!;
  if (marketId && detected !== marketId) {
    throw new Error("A scanner batch must contain exactly one market");
  }
  return detected;
}
