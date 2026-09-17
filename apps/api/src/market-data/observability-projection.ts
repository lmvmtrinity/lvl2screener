import type {
  BenchmarkReadiness,
  FeatureSnapshot,
} from "@tsx-scanner/contracts";
import type { MarketDataServiceState } from "./service.js";

export interface ObservabilityProjectionInput {
  state: MarketDataServiceState;
  auth: string;
  dataStatus: string;
  instrumentCount: number;
  lastQuoteAt?: string;
  lastCandleAt?: string;
  lastEvaluationAt?: number;
  lastCycleDurationMs?: number;
  activeMonitoringCycleP95Ms?: number | null;
  activeMonitoringCycleSampleCount?: number;
  lastEngineDurationMs?: number;
  lastFeatureDurationMs?: number;
  lastEvaluationDurationMs?: number;
  benchmarkReadiness?: BenchmarkReadiness;
  latestFeatures: Iterable<FeatureSnapshot>;
  alertsDeliveredTotal: number;
  evaluationsWrittenTotal: number;
  now: number;
}

export interface ObservabilityProjection {
  state: MarketDataServiceState;
  auth: string;
  dataStatus: string;
  instrumentCount: number;
  quoteAgeMs: number | null;
  candleAgeMs: number | null;
  benchmarkAgeMs: number | null;
  evaluationAgeMs: number | null;
  cycleLatencyMs: number | null;
  activeMonitoringCycleP95Ms: number | null;
  activeMonitoringCycleSampleCount: number;
  engineLatencyMs: number | null;
  featureLatencyMs: number | null;
  evaluationLatencyMs: number | null;
  missingBarsCount: number;
  readySymbols: number;
  warmingSymbols: number;
  unavailableSymbols: number;
  alertsDeliveredTotal: number;
  evaluationsWrittenTotal: number;
}

/** W9: extracted from `QuestradeDataService.getObservability` as a pure function of a plain data
 * snapshot, so the age/latency/readiness math it does (previously inline in the service) can be
 * reasoned about — and unit-tested — independently of the service's mutable state. */
export function projectObservability(
  input: ObservabilityProjectionInput,
): ObservabilityProjection {
  const age = (iso?: string): number | null =>
    iso ? Math.max(0, input.now - Date.parse(iso)) : null;
  const benchmarkTimestamps = [
    input.benchmarkReadiness?.market?.timestamp ?? null,
    ...(input.benchmarkReadiness?.sectors.map((sector) => sector.timestamp) ??
      []),
  ].filter((value): value is string => Boolean(value));
  const benchmarkAgeMs =
    benchmarkTimestamps.length > 0
      ? Math.max(
          ...benchmarkTimestamps.map((value) => input.now - Date.parse(value)),
        )
      : null;
  let missingBarsCount = 0,
    readySymbols = 0,
    warmingSymbols = 0,
    unavailableSymbols = 0;
  for (const feature of input.latestFeatures) {
    if (feature.warmingUp.length > 0) {
      missingBarsCount += feature.warmingUp.length;
      warmingSymbols += 1;
    } else if (
      feature.dataStatus === "HALTED" ||
      feature.dataStatus === "DELAYED"
    )
      unavailableSymbols += 1;
    else readySymbols += 1;
  }
  return {
    state: input.state,
    auth: input.auth,
    dataStatus: input.dataStatus,
    instrumentCount: input.instrumentCount,
    quoteAgeMs: age(input.lastQuoteAt),
    candleAgeMs: age(input.lastCandleAt),
    benchmarkAgeMs,
    evaluationAgeMs:
      input.lastEvaluationAt !== undefined
        ? Math.max(0, input.now - input.lastEvaluationAt)
        : null,
    cycleLatencyMs: input.lastCycleDurationMs ?? null,
    activeMonitoringCycleP95Ms: input.activeMonitoringCycleP95Ms ?? null,
    activeMonitoringCycleSampleCount:
      input.activeMonitoringCycleSampleCount ?? 0,
    engineLatencyMs: input.lastEngineDurationMs ?? null,
    featureLatencyMs: input.lastFeatureDurationMs ?? null,
    evaluationLatencyMs: input.lastEvaluationDurationMs ?? null,
    missingBarsCount,
    readySymbols,
    warmingSymbols,
    unavailableSymbols,
    alertsDeliveredTotal: input.alertsDeliveredTotal,
    evaluationsWrittenTotal: input.evaluationsWrittenTotal,
  };
}
