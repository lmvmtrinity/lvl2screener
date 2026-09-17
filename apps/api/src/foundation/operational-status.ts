import type {
  OperationalReasonCode,
  OperationalStatus,
} from "@tsx-scanner/contracts";

/**
 * Everything the actionability contract needs, expressed as primitives so it has no dependency on
 * the market-data service, the universe manager, or Postgres. Every operator surface — `/health/ready`,
 * `/api/system/status`, `/metrics`, and the web footer — derives its actionability from one call to
 * {@link computeOperationalStatus} instead of each reimplementing its own rule.
 */
export interface OperationalStatusInput {
  databaseReady: boolean;
  scannerReady: boolean;
  marketDataMode: "mock" | "live";
  auth: "CONNECTED" | "AUTH_REQUIRED" | "UNKNOWN";
  /** `null` while the session has not been resolved yet (service still starting). */
  marketStatus: string | null;
  phase: string | null;
  quoteAgeMs: number | null;
  candleAgeMs: number | null;
  benchmarkAgeMs: number | null;
  evaluationAgeMs: number | null;
  /** Symbols the operator configured for the universe (watchlist / provider config). */
  universeConfigured: number;
  /** Symbols the universe provider actually resolved to tradeable instruments. */
  universeResolved: number;
  /** Strategy evaluations currently held for the resolved universe — the write path W1 fixed. */
  universeEvaluated: number;
  benchmarkReady: boolean;
  /** Whether the scanner engine has acknowledged the profiles/session currently in force. */
  scannerSynchronized: boolean;
  /** Quote/candle age, in ms, beyond which open-session data is considered stale. */
  staleDataThresholdMs?: number;
}

const DEFAULT_STALE_DATA_THRESHOLD_MS = 60_000;

export function computeOperationalStatus(
  input: OperationalStatusInput,
): OperationalStatus {
  const reasonCodes: OperationalReasonCode[] = [];
  const serviceReady = input.databaseReady && input.scannerReady;

  if (!input.databaseReady) reasonCodes.push("DATABASE_UNAVAILABLE");
  if (!input.scannerReady) reasonCodes.push("SCANNER_UNAVAILABLE");
  if (input.marketStatus === null) reasonCodes.push("SERVICE_STARTING");
  if (input.auth !== "CONNECTED") reasonCodes.push("AUTH_REQUIRED");
  if (!input.benchmarkReady) reasonCodes.push("BENCHMARKS_UNRESOLVED");
  if (!input.scannerSynchronized) reasonCodes.push("SCANNER_OUT_OF_SYNC");
  if (input.marketStatus !== null && input.marketStatus !== "OPEN")
    reasonCodes.push("MARKET_CLOSED");

  // An empty universe and a resolved-but-not-yet-evaluated universe are both non-actionable, but
  // distinct: the operator can paste a watchlist for the first, and only needs to wait for the
  // second. Either way this must never look like ACTIVE — this is the highest-value guard in W6.
  if (input.universeConfigured === 0) {
    reasonCodes.push("EMPTY_UNIVERSE");
  } else if (
    input.universeResolved === 0 ||
    (input.marketStatus === "OPEN" && input.universeEvaluated === 0)
  ) {
    reasonCodes.push("WAITING_FOR_CANDIDATES");
  }

  const staleThreshold =
    input.staleDataThresholdMs ?? DEFAULT_STALE_DATA_THRESHOLD_MS;
  const stale =
    input.marketStatus === "OPEN" &&
    [input.quoteAgeMs, input.candleAgeMs].some(
      (age) => age !== null && age > staleThreshold,
    );
  if (stale) reasonCodes.push("DATA_STALE");

  const operationalReady =
    serviceReady &&
    input.marketStatus !== null &&
    input.auth === "CONNECTED" &&
    input.benchmarkReady &&
    input.scannerSynchronized;

  const actionable = serviceReady && reasonCodes.length === 0;

  return {
    serviceReady,
    operationalReady,
    actionable,
    reasonCodes,
    marketDataMode: input.marketDataMode,
    session:
      input.marketStatus === null
        ? null
        : { marketStatus: input.marketStatus, phase: input.phase },
    auth: input.auth,
    dataFreshness: {
      quoteAgeMs: input.quoteAgeMs,
      candleAgeMs: input.candleAgeMs,
      benchmarkAgeMs: input.benchmarkAgeMs,
      evaluationAgeMs: input.evaluationAgeMs,
    },
    universe: {
      configured: input.universeConfigured,
      resolved: input.universeResolved,
      evaluated: input.universeEvaluated,
    },
    benchmarkReady: input.benchmarkReady,
    scannerSynchronized: input.scannerSynchronized,
  };
}
