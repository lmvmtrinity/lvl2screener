import {
  activeStatisticalPredictionsSchema,
  alertListSchema,
  alertPolicySchema,
  backtestRunListSchema,
  candidateListSchema,
  contextEvaluationListSchema,
  scannerProfileListSchema,
  strategyDefinitionListSchema,
  systemStatusSchema,
  universeResponseSchema,
  type AlertPolicy,
  type BacktestRun,
  type ContextEvaluation,
  type ScannerAlert,
  type ScannerProfile,
  type StatisticalPrediction,
  type StrategyDefinition,
  type StrategyEvaluation,
  type SystemStatus,
  type UniverseAutomation,
} from "@tsx-scanner/contracts";
import { getJson } from "./api.js";
import type { MarketStatus } from "../types.js";

/** W9: the initial page load used to be one `Promise.all` over every endpoint the app touches —
 * research verticals (backtests, calibrations, statistical models, profiles) included.
 * Any single failure (an outage in one research vertical, a slow deploy) rejected the whole batch
 * and the board never rendered anything at all, even though nothing about, say, the backtests
 * endpoint being down should stop the live scanner board from showing candidates.
 *
 * `loadBootstrap` splits requests into two groups: `critical` (everything the scanner board
 * itself needs) still fails the whole bootstrap if any of it is missing — there is no meaningful
 * board without it — while `optional` (the research verticals plus the alert policy) is fetched
 * with `Promise.allSettled` so one endpoint's failure only leaves that one slice of state at its
 * default, without blocking the critical group's `Promise.all` or the rest of the optional
 * group's results. */
export interface CriticalBootstrap {
  system: SystemStatus;
  market: MarketStatus;
  universe: UniverseAutomation;
  candidates: StrategyEvaluation[];
  contexts: ContextEvaluation[];
  alerts: ScannerAlert[];
}

export interface OptionalBootstrap {
  backtests: BacktestRun[];
  profiles: ScannerProfile[];
  definitions: StrategyDefinition[];
  alertPolicy: AlertPolicy;
}

export interface BootstrapResult {
  critical: CriticalBootstrap;
  optional: Partial<OptionalBootstrap>;
  /** Keys of the optional group whose request failed — used only for diagnostics (e.g. a soft
   * banner); state for a failed key simply stays at its React default. */
  optionalFailures: (keyof OptionalBootstrap)[];
}

export async function loadBootstrap(
  signal: AbortSignal,
  marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
): Promise<BootstrapResult> {
  const marketQuery = `?marketId=${marketId}`;
  const [
    system,
    market,
    universeResponse,
    candidatesResponse,
    contextsResponse,
    alertsResponse,
  ] = await Promise.all([
    getJson(`/api/system/status?marketId=${marketId}`, signal).then((raw) =>
      systemStatusSchema.parse(raw),
    ),
    getJson(
      `/api/market/status${marketQuery}`,
      signal,
    ) as Promise<MarketStatus>,
    getJson(`/api/universe${marketQuery}`, signal).then((raw) =>
      universeResponseSchema.parse(raw),
    ),
    getJson(`/api/candidates${marketQuery}`, signal).then((raw) =>
      candidateListSchema.parse(raw),
    ),
    getJson(`/api/contexts${marketQuery}`, signal).then((raw) =>
      contextEvaluationListSchema.parse(raw),
    ),
    getJson(`/api/alerts?limit=100&marketId=${marketId}`, signal).then((raw) =>
      alertListSchema.parse(raw),
    ),
  ]);

  const optionalLoaders: {
    [K in keyof OptionalBootstrap]: () => Promise<OptionalBootstrap[K]>;
  } = {
    backtests: () =>
      getJson("/api/backtests?limit=100", signal).then(
        (raw) => backtestRunListSchema.parse(raw).runs,
      ),
    profiles: () =>
      getJson("/api/scanner-profiles", signal).then(
        (raw) => scannerProfileListSchema.parse(raw).profiles,
      ),
    definitions: () =>
      getJson("/api/strategies", signal).then(
        (raw) => strategyDefinitionListSchema.parse(raw).strategies,
      ),
    alertPolicy: () =>
      getJson(`/api/alerts/policy?marketId=${marketId}`, signal).then((raw) =>
        alertPolicySchema.parse(raw),
      ),
  };

  const keys = Object.keys(optionalLoaders) as (keyof OptionalBootstrap)[];
  const settled = await Promise.allSettled(
    keys.map((key) => optionalLoaders[key]()),
  );
  const optional: Partial<OptionalBootstrap> = {};
  const optionalFailures: (keyof OptionalBootstrap)[] = [];
  settled.forEach((result, index) => {
    const key = keys[index];
    if (result.status === "fulfilled")
      (optional as Record<string, unknown>)[key] = result.value;
    else optionalFailures.push(key);
  });

  return {
    critical: {
      system,
      market,
      universe: universeResponse.automation,
      candidates: candidatesResponse.candidates,
      contexts: contextsResponse.contexts,
      alerts: alertsResponse.alerts,
    },
    optional,
    optionalFailures,
  };
}

/** Polled separately from bootstrap (every 10s, independent of the WS stream) — kept here so
 * App.tsx's effect stays a thin call site. Optional by nature: no active statistical model just
 * means an empty array, never an error the user needs to see. */
export async function loadActivePredictions(): Promise<
  StatisticalPrediction[]
> {
  try {
    const value = activeStatisticalPredictionsSchema.parse(
      await getJson("/api/statistical-models/active/predictions"),
    );
    return value.models.flatMap((model) => model.predictions);
  } catch {
    return [];
  }
}

/** Full status check used by the shell's automation row. WebSocket frames
 * suppress unchanged content by design, so this REST read is what proves the
 * displayed status is fresh; the caller keeps its own "checked at" clock.
 * Scoped to the selected market so its session, universe, gating and freshness
 * never come from another runtime's service. */
export async function loadSystemStatus(
  marketId: "CA_TSX" | "US_EQUITIES",
  signal?: AbortSignal,
): Promise<SystemStatus> {
  return systemStatusSchema.parse(
    await getJson(`/api/system/status?marketId=${marketId}`, signal),
  );
}

export async function loadMarketStatus(
  marketId: "CA_TSX" | "US_EQUITIES",
  signal?: AbortSignal,
): Promise<MarketStatus> {
  return (await getJson(
    `/api/market/status?marketId=${marketId}`,
    signal,
  )) as MarketStatus;
}
