import type { CreateBacktest, MarketId } from "@tsx-scanner/contracts";

/** Current Python simulation path; replaced when the TypeScript execution core takes authority. */
export const LEGACY_PYTHON_EXECUTION_MODEL_VERSION = "legacy-python-v1";
// v2 corrected the live TSX/CAD commission default to zero and added a
// cost-aware target-viability entry gate. v3 adds the full economic-viability
// gate (its own REJECTED_ECONOMICS decision and reason codes), sizes against
// the slippage-adjusted stop, and defines R on that same cost-inclusive
// initial risk. Runs preserve this version alongside their immutable
// assumptions so earlier evidence is never silently reinterpreted, and
// cohorts from different versions are never merged.
// v4 normalizes Questrade Canadian displayed board lots to shares before
// sizing and records the raw provider quantity and multiplier with quotes.
// v5 extends the scanner and paper-bot session through the regular TSX close.
// Existing v4 runs retain their immutable noon-close assumptions.
// v6 incorporates Phase A, B, and C audit remediations (2026-09-04):
// - Gap-through stop execution at min(open, stop) - slippage (F-04)
// - Strict candle admissibility: candle.start >= entryTime (F-02)
// - Top-of-book displayed size capacity constraints and unfilled shares tracking (F-05)
// The current value lives in contracts so API and web cannot drift; matching
// it identifies the execution version only, never evidence quality.
export { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "@tsx-scanner/contracts";

/**
 * Execution snapshots retain the market's named calendar policy even where
 * the current North-American venues share Eastern clock time.
 */
export function marketSessionTimezone(
  marketId: MarketId = "CA_TSX",
): "America/Toronto" | "America/New_York" {
  return marketId === "US_EQUITIES" ? "America/New_York" : "America/Toronto";
}

export function legacyPythonExecutionAssumptions(
  input: Pick<
    CreateBacktest,
    | "marketId"
    | "startingCapital"
    | "positionSize"
    | "slippageBps"
    | "feePerTrade"
  >,
): Record<string, unknown> {
  return {
    startingCapital: input.startingCapital,
    positionSize: input.positionSize,
    slippageBps: input.slippageBps,
    feePerTrade: input.feePerTrade,
    stopMethod: "STRUCTURAL",
    atrStopMultiple: 1,
    rewardRiskRatio: null,
    sessionTimezone: marketSessionTimezone(input.marketId),
    sessionCloseTime: "16:00",
    fillAuthority: "PYTHON_SIMULATE_TRADES",
  };
}

export function authoritativeExecutionAssumptions(
  input: Pick<
    CreateBacktest,
    | "marketId"
    | "startingCapital"
    | "positionSize"
    | "slippageBps"
    | "feePerTrade"
  >,
): Record<string, unknown> {
  return {
    startingCapital: input.startingCapital,
    positionSize: input.positionSize,
    slippageBps: input.slippageBps,
    feePerTrade: input.feePerTrade,
    stopMethod: "STRUCTURAL",
    atrStopMultiple: 1,
    rewardRiskRatio: null,
    maxQuoteAgeSeconds: 30,
    sessionTimezone: marketSessionTimezone(input.marketId),
    noonCloseTime: "16:00",
    executionMode: "UNCONSTRAINED",
    latencyMs: 0,
    fillAuthority: "TYPESCRIPT_PAPER_EXECUTION_CORE",
  };
}
