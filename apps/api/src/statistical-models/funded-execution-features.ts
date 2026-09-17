import type {
  FundedDecisionTimeInput,
  FundedExecutionFeatureVector,
  MarketId,
} from "@tsx-scanner/contracts";

/**
 * Decision-only feature extraction for funded-execution learning (FP02).
 *
 * Every value is sourceable from the retained version-2 decision-time input.
 * Nothing later (fills, exits, costs, corrections, current account state) can
 * enter this vector. Absent or unit-ambiguous values stay null and are imputed
 * from training medians recorded in the artifact; they are never defaulted to
 * zero here.
 */

const MARKET_TIMEZONES: Record<MarketId, string> = {
  CA_TSX: "America/Toronto",
  US_EQUITIES: "America/New_York",
};

export function fundedExecutionSessionDate(
  decisionAt: string,
  marketId: MarketId,
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIMEZONES[marketId],
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(decisionAt));
}

export function extractFundedExecutionFeatures(input: {
  decision: FundedDecisionTimeInput;
  marketId: MarketId;
}): FundedExecutionFeatureVector {
  const { decision, marketId } = input;
  const quote =
    decision.quote.status === "AVAILABLE" ? decision.quote.snapshot : null;
  const portfolio =
    decision.portfolio.status === "AVAILABLE" ? decision.portfolio : null;
  const capital =
    decision.requestedCapital.status === "AVAILABLE"
      ? decision.requestedCapital
      : null;

  const spreadPct = quote
    ? (() => {
        const mid = (quote.bid + quote.ask) / 2;
        if (!(mid > 0)) return null;
        return Math.max(0, ((quote.ask - quote.bid) / mid) * 100);
      })()
    : null;

  // Board-lot quote sizes cannot be compared with share-denominated features.
  const displayedSize =
    quote && quote.sizeUnit === "SHARES" && quote.sizeMultiplier !== null
      ? quote.askSize * quote.sizeMultiplier
      : null;

  const quoteAgeSeconds =
    quote !== null
      ? (Date.parse(decision.decisionAt) - Date.parse(quote.timestamp)) / 1000
      : null;

  const entry = decision.signal.entryReference;
  const stop = decision.signal.stopReference;
  const target = decision.signal.targetReference;
  const atr = decision.signal.atr14;

  const local = new Date(decision.decisionAt).toLocaleString("en-GB", {
    timeZone: MARKET_TIMEZONES[marketId],
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const [hour, minute] = local.split(":").map(Number);

  const contextStrength = (() => {
    if (decision.context.status !== "AVAILABLE") return null;
    switch (decision.context.contextStatus) {
      case "UNAVAILABLE":
        return 0;
      case "STALE":
        return 0;
      case "WEAK":
        return 1;
      case "NEUTRAL":
        return 2;
      case "STRONG":
        return 3;
      default:
        return null;
    }
  })();

  const ratio = (
    numerator: number | null,
    denominator: number | null,
  ): number | null =>
    numerator !== null && denominator !== null && denominator > 0
      ? numerator / denominator
      : null;

  return {
    deterministicScore: decision.score,
    spreadPct: finiteOrNull(spreadPct),
    logDisplayedSize:
      displayedSize !== null && displayedSize >= 0
        ? Math.log1p(displayedSize)
        : null,
    logRequestedNotional: capital ? Math.log1p(capital.maximumDebit) : null,
    logRequestedRisk: capital ? Math.log1p(capital.maximumRisk) : null,
    quoteAgeSeconds:
      quoteAgeSeconds !== null && finiteOrNull(quoteAgeSeconds) !== null
        ? Math.max(0, quoteAgeSeconds)
        : null,
    minutesFromOpen:
      hour !== undefined && minute !== undefined
        ? hour * 60 + minute - 570
        : null,
    atrPct: finiteOrNull(ratio(atr, entry)),
    stopDistancePct:
      entry !== null && stop !== null
        ? finiteOrNull(Math.abs(entry - stop) / entry)
        : null,
    targetDistancePct:
      entry !== null && target !== null
        ? finiteOrNull(Math.abs(target - entry) / entry)
        : null,
    logCash: portfolio ? Math.log1p(portfolio.cash) : null,
    logOpenRisk: portfolio ? Math.log1p(portfolio.openRisk) : null,
    logReservedRisk: portfolio ? Math.log1p(portfolio.reservedRisk) : null,
    positionCount: portfolio ? portfolio.positionCount : null,
    participation: finiteOrNull(decision.policy.participation),
    contextStrength,
  };
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}
