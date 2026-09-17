import { canonicalJson } from "../backtests/research-coverage.js";
import type {
  BookSide,
  DiagnosticAllocationInput,
  DiagnosticFill,
  DiagnosticQuote,
  ExecutionDiagnosticEvidence,
  ResourceContentionDiagnostic,
} from "./execution-diagnostics-types.js";
import { analyzeSnapshotReplenishment } from "./snapshot-replenishment-diagnostics.js";

function sideSize(quote: DiagnosticQuote, side: BookSide): number {
  return side === "ASK" ? quote.quote.askSize : quote.quote.bidSize;
}

function groupKey(row: DiagnosticAllocationInput): string {
  return `${row.runId}\u0000${row.instrumentId}\u0000${row.quoteEvidenceId}\u0000${row.side}`;
}

function compareAllocation(
  left: DiagnosticAllocationInput,
  right: DiagnosticAllocationInput,
): number {
  return (
    (left.side === "ASK"
      ? Date.parse(left.releaseAt)
      : Date.parse(left.submittedAt)) -
      (right.side === "ASK"
        ? Date.parse(right.releaseAt)
        : Date.parse(right.submittedAt)) ||
    Date.parse(left.submittedAt) - Date.parse(right.submittedAt) ||
    (left.orderId < right.orderId ? -1 : left.orderId > right.orderId ? 1 : 0)
  );
}

function uniqueFills(fills: readonly DiagnosticFill[]): DiagnosticFill[] {
  const byId = new Map<string, DiagnosticFill>();
  for (const fill of fills) {
    const prior = byId.get(fill.eventId);
    if (prior && canonicalJson(prior) !== canonicalJson(fill))
      throw new Error("Conflicting diagnostic event identity");
    if (!prior) byId.set(fill.eventId, fill);
  }
  return [...byId.values()];
}

function filledShares(
  fills: readonly DiagnosticFill[],
  allocation: DiagnosticAllocationInput,
): number {
  return fills.reduce(
    (total, fill) =>
      fill.runId === allocation.runId &&
      fill.instrumentId === allocation.instrumentId &&
      fill.orderId === allocation.orderId &&
      fill.quoteEvidenceId === allocation.quoteEvidenceId &&
      fill.side === allocation.side
        ? total + fill.shares
        : total,
    0,
  );
}

function quoteBudget(
  quote: DiagnosticQuote | undefined,
  side: BookSide,
): number | null {
  return quote?.participation === null || quote === undefined
    ? null
    : Math.floor(sideSize(quote, side) * quote.participation);
}

export function explainResourceContention(
  evidence: ExecutionDiagnosticEvidence,
): ResourceContentionDiagnostic {
  // This also applies the shared quote admissibility and identity validation before any
  // diagnostic interpretation is attempted. The result itself is intentionally not used to
  // infer missing capacity.
  const replenishment = analyzeSnapshotReplenishment(evidence);
  const excludedQuoteIds = new Set(
    replenishment.excluded.map((entry) => entry.evidenceId),
  );
  const quoteById = new Map(
    evidence.quotes.map((quote) => [quote.evidenceId, quote]),
  );
  const fills = uniqueFills(evidence.fills);
  const groups = new Map<string, DiagnosticAllocationInput[]>();
  for (const allocation of evidence.allocations) {
    const group = groups.get(groupKey(allocation)) ?? [];
    group.push(allocation);
    groups.set(groupKey(allocation), group);
  }

  const rows = [...groups.values()].flatMap((group) => {
    const sorted = [...group].sort(compareAllocation);
    const exactCandidateSet =
      !evidence.unavailable.some(
        (reason) =>
          reason === "MISSING_ORDER_HISTORY" ||
          reason === "UNVERIFIED_EVENT_SEQUENCE",
      ) && sorted.every((allocation) => allocation.completeness === "EXACT");
    let consumedBefore = 0;
    return sorted.map((allocation, index) => {
      const quote = excludedQuoteIds.has(allocation.quoteEvidenceId)
        ? undefined
        : quoteById.get(allocation.quoteEvidenceId);
      const budget = quoteBudget(quote, allocation.side);
      const unavailable = new Set<
        "MISSING_HISTORICAL_BUDGET" | "MISSING_ALLOCATION_INPUTS"
      >();
      if (!quote) unavailable.add("MISSING_ALLOCATION_INPUTS");
      else if (budget === null) unavailable.add("MISSING_HISTORICAL_BUDGET");
      if (!exactCandidateSet) unavailable.add("MISSING_ALLOCATION_INPUTS");
      const filled = filledShares(fills, allocation);
      const remainingBudgetBeforeOrder =
        budget === null || !exactCandidateSet
          ? null
          : Math.max(0, budget - consumedBefore);
      const capacityBoundConfirmed =
        allocation.requestedShares !== null &&
        filled < allocation.requestedShares &&
        remainingBudgetBeforeOrder !== null &&
        filled === remainingBudgetBeforeOrder;
      const reason: ResourceContentionDiagnostic["rows"][number]["reason"] =
        allocation.explicitReason
          ? "RECORDED_REASON"
          : capacityBoundConfirmed
            ? "CAPACITY_BOUND_CONFIRMED"
            : allocation.requestedShares !== null &&
                filled >= allocation.requestedShares
              ? "FILLED"
              : filled > 0
                ? "PARTIAL_FILL"
                : "UNAVAILABLE";
      if (budget !== null && exactCandidateSet) consumedBefore += filled;
      const remainingOwnedShares =
        allocation.afterShares ??
        (allocation.beforeShares === null || allocation.side !== "BID"
          ? null
          : Math.max(0, allocation.beforeShares - filled));
      return {
        runId: allocation.runId,
        instrumentId: allocation.instrumentId,
        orderId: allocation.orderId,
        quoteEvidenceId: allocation.quoteEvidenceId,
        side: allocation.side,
        canonicalRank: exactCandidateSet ? index + 1 : null,
        requestedShares: allocation.requestedShares,
        filledShares: filled,
        remainingOwnedShares,
        initialBudgetShares: budget,
        remainingBudgetBeforeOrder,
        reason,
        recordedReason: allocation.explicitReason,
        unavailable: [...unavailable].sort(),
      };
    });
  });
  return { scope: evidence.scope, rows };
}
