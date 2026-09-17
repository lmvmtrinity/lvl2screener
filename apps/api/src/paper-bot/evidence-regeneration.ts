import type { Pool } from "pg";
import type { StrategyStateEvent, MarketId } from "@tsx-scanner/contracts";
import {
  type QuoteExecutionState,
  type CandleExecutionState,
} from "./execution-core.js";
import { zonedSessionBoundary } from "./session-time.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";
import type { AssumptionsSnapshot, CandleFact, QuoteFact } from "./types.js";
import { executeEvent } from "../backtests/authoritative-backtest-executor.js";
import type { PaperSignalObservation } from "./paper-bot-repository.js";

export type EvidenceReproducibility =
  | "REPRODUCIBLE"
  | "UNREPRODUCIBLE_MISSING_QUOTES"
  | "UNREPRODUCIBLE_INCOMPATIBLE_SEMANTICS"
  | "UNREPRODUCIBLE_INCOMPLETE_CANDLES";

export interface RegenerationExecutionSummary {
  readonly quoteState: QuoteExecutionState;
  readonly candleState: CandleExecutionState;
  readonly observationId: string;
  readonly symbol: string;
  readonly strategyKey: string;
  readonly quoteStatus: string;
  readonly quoteExitReason?: string;
  readonly quoteNetPnl?: number;
  readonly quoteRMultiple?: number;
  readonly quoteUnfilledShares?: number;
  readonly candleStatus: string;
  readonly candleExitReason?: string;
  readonly candleNetPnl?: number;
  readonly candleRMultiple?: number;
  readonly gapThroughStopApplied: boolean;
}

export interface SessionRegenerationResult {
  readonly originalRunId: string;
  readonly sessionDate: string;
  readonly marketId: MarketId;
  readonly executionModelVersion: string;
  readonly reproducibility: EvidenceReproducibility;
  readonly totalObservations: number;
  readonly closedQuoteCount: number;
  readonly closedCandleCount: number;
  readonly quoteNetPnl: number;
  readonly quoteCumulativeR: number;
  readonly candleNetPnl: number;
  readonly candleCumulativeR: number;
  readonly totalUnfilledShares: number;
  readonly gapThroughStopsCount: number;
  readonly executions: readonly RegenerationExecutionSummary[];
}

export function classifySessionReproducibility(
  quotes: readonly QuoteFact[],
  candles: readonly CandleFact[],
  options?: { readonly isLegacyFillAuthority?: boolean },
): EvidenceReproducibility {
  if (options?.isLegacyFillAuthority) {
    return "UNREPRODUCIBLE_INCOMPATIBLE_SEMANTICS";
  }
  if (!quotes || quotes.length === 0) {
    return "UNREPRODUCIBLE_MISSING_QUOTES";
  }
  if (!candles || candles.length === 0) {
    return "UNREPRODUCIBLE_INCOMPLETE_CANDLES";
  }
  return "REPRODUCIBLE";
}

export function regenerateSessionEvidence(input: {
  readonly originalRunId: string;
  readonly sessionDate: string;
  readonly marketId: MarketId;
  readonly observations: readonly PaperSignalObservation[];
  readonly quotesByInstrument: ReadonlyMap<string, readonly QuoteFact[]>;
  readonly candlesByInstrument: ReadonlyMap<string, readonly CandleFact[]>;
  readonly assumptions: AssumptionsSnapshot;
  readonly executionModelVersion?: string;
  readonly isLegacyFillAuthority?: boolean;
}): SessionRegenerationResult {
  const version =
    input.executionModelVersion ?? AUTHORITATIVE_EXECUTION_MODEL_VERSION;
  if (version !== AUTHORITATIVE_EXECUTION_MODEL_VERSION)
    throw new Error("Only the current execution implementation is available");
  if (
    input.observations.some(
      (observation) => observation.marketId !== input.marketId,
    )
  )
    throw new Error("Observation market mismatch");
  const allQuotes = [...input.quotesByInstrument.values()].flat();
  const allCandles = [...input.candlesByInstrument.values()].flat();

  let reproducibility = classifySessionReproducibility(allQuotes, allCandles, {
    isLegacyFillAuthority: input.isLegacyFillAuthority,
  });

  if (reproducibility !== "REPRODUCIBLE") {
    return {
      originalRunId: input.originalRunId,
      sessionDate: input.sessionDate,
      marketId: input.marketId,
      executionModelVersion: version,
      reproducibility,
      totalObservations: input.observations.length,
      closedQuoteCount: 0,
      closedCandleCount: 0,
      quoteNetPnl: 0,
      quoteCumulativeR: 0,
      candleNetPnl: 0,
      candleCumulativeR: 0,
      totalUnfilledShares: 0,
      gapThroughStopsCount: 0,
      executions: [],
    };
  }

  const boundary = zonedSessionBoundary(
    input.sessionDate,
    input.assumptions.noonCloseTime ?? "16:00",
    input.assumptions.sessionTimezone,
  );
  const boundaryMs = Date.parse(boundary);
  const sessionStartMs = Date.parse(
    zonedSessionBoundary(
      input.sessionDate,
      "00:00",
      input.assumptions.sessionTimezone,
    ),
  );
  const nextDate = new Date(
    Date.parse(`${input.sessionDate}T00:00:00Z`) + 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const sessionEndMs = Date.parse(
    zonedSessionBoundary(nextDate, "00:00", input.assumptions.sessionTimezone),
  );

  let closedQuoteCount = 0;
  let closedCandleCount = 0;
  let quoteNetPnl = 0;
  let quoteCumulativeR = 0;
  let candleNetPnl = 0;
  let candleCumulativeR = 0;
  let totalUnfilledShares = 0;
  let gapThroughStopsCount = 0;

  const executionSummaries: RegenerationExecutionSummary[] = [];

  for (const obs of input.observations) {
    if (obs.eligibilityStatus !== "ELIGIBLE") continue;
    const signalMs = Date.parse(obs.signalTimestamp);
    if (
      signalMs < sessionStartMs ||
      signalMs >= boundaryMs ||
      !Number.isFinite(signalMs)
    )
      throw new Error("Observation outside source trading session");
    const quotes = [...(input.quotesByInstrument.get(obs.instrumentId) ?? [])]
      .filter(
        (quote) =>
          Date.parse(quote.timestamp) >= sessionStartMs &&
          Date.parse(quote.timestamp) < sessionEndMs,
      )
      .sort(
        (left, right) =>
          Date.parse(left.timestamp) - Date.parse(right.timestamp),
      );
    const candles = [
      ...(input.candlesByInstrument.get(obs.instrumentId) ?? []),
    ].sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
    if (
      !quotes.some(
        (quote) =>
          Date.parse(quote.timestamp) <= signalMs &&
          signalMs - Date.parse(quote.timestamp) <=
            input.assumptions.maxQuoteAgeSeconds * 1000,
      )
    ) {
      reproducibility = "UNREPRODUCIBLE_MISSING_QUOTES";
    } else if (
      !candles.some((candle) => Date.parse(candle.start) >= signalMs)
    ) {
      reproducibility = "UNREPRODUCIBLE_INCOMPLETE_CANDLES";
    }
    const event = {
      timestamp: obs.signalTimestamp,
      entryReference: obs.entryReference,
      stopReference: obs.stopReference,
      targetReference: obs.targetReference,
      featureSnapshot: { atr14: obs.atr14 },
    } as StrategyStateEvent;
    const replayed = executeEvent(
      event,
      true,
      quotes.map((quote) => ({ ...quote, instrumentId: obs.instrumentId })),
      candles.map((candle) => ({ ...candle, instrumentId: obs.instrumentId })),
      input.assumptions,
    );
    const quoteState = replayed.quote!;
    const candleState = replayed.candle!;
    if (quoteState.status === "CLOSE_PENDING")
      reproducibility = "UNREPRODUCIBLE_MISSING_QUOTES";
    if (candleState.status === "CLOSE_PENDING")
      reproducibility = "UNREPRODUCIBLE_INCOMPLETE_CANDLES";
    if (
      candleState.status === "CLOSED" ||
      candleState.status === "CLOSE_PENDING"
    ) {
      const coverageEnd =
        candleState.status === "CLOSED"
          ? Date.parse(candleState.exit.exitTime)
          : boundaryMs;
      const completeMinutes = new Set(
        candles
          .filter(
            (candle) =>
              Date.parse(candle.end) - Date.parse(candle.start) === 60_000,
          )
          .map((candle) => Date.parse(candle.start)),
      );
      for (
        let minute = Math.ceil(signalMs / 60_000) * 60_000;
        minute < coverageEnd;
        minute += 60_000
      ) {
        if (!completeMinutes.has(minute)) {
          reproducibility = "UNREPRODUCIBLE_INCOMPLETE_CANDLES";
          break;
        }
      }
    }
    const gapThroughStopApplied =
      candleState.status === "CLOSED" &&
      candleState.exit.exitReason === "STOP" &&
      candles.some(
        (candle) =>
          candle.end === candleState.exit.exitTime &&
          candle.open < candleState.position.stop,
      );

    // Record metrics
    let qNetPnl: number | undefined;
    let qRMultiple: number | undefined;
    let qExitReason: string | undefined;
    let qUnfilled: number | undefined;

    if (quoteState.status === "CLOSED") {
      closedQuoteCount++;
      qNetPnl = quoteState.exit.financials.netPnl;
      qRMultiple = quoteState.exit.financials.rMultiple;
      qExitReason = quoteState.exit.exitReason;
      qUnfilled = quoteState.exit.unfilledShares;
      quoteNetPnl += qNetPnl;
      quoteCumulativeR += qRMultiple;
      if (qUnfilled) totalUnfilledShares += qUnfilled;
    }

    let cNetPnl: number | undefined;
    let cRMultiple: number | undefined;
    let cExitReason: string | undefined;

    if (candleState.status === "CLOSED") {
      closedCandleCount++;
      cNetPnl = candleState.exit.financials.netPnl;
      cRMultiple = candleState.exit.financials.rMultiple;
      cExitReason = candleState.exit.exitReason;
      candleNetPnl += cNetPnl;
      candleCumulativeR += cRMultiple;
      if (gapThroughStopApplied && cExitReason === "STOP") {
        gapThroughStopsCount++;
      }
    }

    executionSummaries.push({
      quoteState,
      candleState,
      observationId: obs.id,
      symbol: obs.symbol,
      strategyKey: obs.strategyKey,
      quoteStatus: quoteState.status,
      quoteExitReason: qExitReason,
      quoteNetPnl: qNetPnl,
      quoteRMultiple: qRMultiple,
      quoteUnfilledShares: qUnfilled,
      candleStatus: candleState.status,
      candleExitReason: cExitReason,
      candleNetPnl: cNetPnl,
      candleRMultiple: cRMultiple,
      gapThroughStopApplied: gapThroughStopApplied && cExitReason === "STOP",
    });
  }

  return {
    originalRunId: input.originalRunId,
    sessionDate: input.sessionDate,
    marketId: input.marketId,
    executionModelVersion: version,
    reproducibility,
    totalObservations: input.observations.length,
    closedQuoteCount,
    closedCandleCount,
    quoteNetPnl: Math.round(quoteNetPnl * 100) / 100,
    quoteCumulativeR: Math.round(quoteCumulativeR * 100) / 100,
    candleNetPnl: Math.round(candleNetPnl * 100) / 100,
    candleCumulativeR: Math.round(candleCumulativeR * 100) / 100,
    totalUnfilledShares,
    gapThroughStopsCount,
    executions: executionSummaries,
  };
}

export class PostgresEvidenceRegenerator {
  constructor(private readonly pool: Pool) {}

  async checkRunReproducibility(
    runId: string,
  ): Promise<EvidenceReproducibility> {
    const { EvidenceRegenerationService } =
      await import("./evidence-regeneration-service.js");
    const result = await new EvidenceRegenerationService(this.pool).run(runId);
    return (result.report as SessionRegenerationResult).reproducibility;
  }
}
