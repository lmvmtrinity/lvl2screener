import type { QuoteFact } from "./types.js";

export type DiagnosticMarket =
  | { marketId: "CA_TSX"; currency: "CAD" }
  | { marketId: "US_EQUITIES"; currency: "USD" };

export type ExecutionDiagnosticScope = DiagnosticMarket & {
  accountId: string;
  selectedRunId: string;
  runIds: readonly string[];
  temporalScope: "RUN_END" | "AS_OF" | "CURRENT_ACCOUNT";
  asOf: string;
};

export type BookSide = "BID" | "ASK";

export type DiagnosticUnknown =
  | "MISSING_QUOTE_HISTORY"
  | "UNVERIFIED_EVENT_SEQUENCE"
  | "MISSING_ORDER_HISTORY"
  | "AMBIGUOUS_FILL_QUOTE_LINK"
  | "MISSING_HISTORICAL_BUDGET"
  | "MISSING_ALLOCATION_INPUTS";

export interface DiagnosticQuote {
  readonly runId: string;
  readonly instrumentId: string;
  readonly evidenceId: string;
  readonly quote: QuoteFact;
  readonly decisionAt: string;
  readonly maxQuoteAgeSeconds: number | null;
  readonly participation: number | null;
  readonly source: "FUNDED_FACT" | "RAW_OBSERVATION";
}

export interface DiagnosticFill {
  readonly runId: string;
  readonly instrumentId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly at: string;
  readonly side: BookSide;
  readonly shares: number;
  readonly quoteEvidenceId: string | null;
  readonly linkUnknown: DiagnosticUnknown | null;
}

export interface DiagnosticAllocationInput {
  readonly runId: string;
  readonly instrumentId: string;
  readonly orderId: string;
  readonly quoteEvidenceId: string;
  readonly side: BookSide;
  readonly submittedAt: string;
  readonly releaseAt: string;
  readonly requestedShares: number | null;
  readonly beforeShares: number | null;
  readonly afterShares: number | null;
  readonly explicitReason: string | null;
  readonly completeness: "EXACT" | "PARTIAL";
}

export interface ExecutionDiagnosticEvidence {
  readonly scope: ExecutionDiagnosticScope;
  readonly quotes: readonly DiagnosticQuote[];
  readonly fills: readonly DiagnosticFill[];
  readonly allocations: readonly DiagnosticAllocationInput[];
  readonly unavailable: readonly DiagnosticUnknown[];
}

export interface SnapshotReplenishmentDiagnostic {
  readonly scope: ExecutionDiagnosticScope;
  readonly stretches: readonly {
    runId: string;
    instrumentId: string;
    side: BookSide;
    startAt: string;
    endAt: string;
    snapshotCount: number;
    displayedShares: number;
    initialBudgetShares: number | null;
    totalFilledShares: number;
    fillsAfterFirstSnapshotShares: number;
    excessOverInitialBudgetShares: number | null;
    assessment: "REPLENISHMENT_UNVERIFIED";
  }[];
  readonly excluded: readonly { evidenceId: string; reason: string }[];
  readonly unlinkedFillShares: Readonly<Record<BookSide, number>>;
  readonly unavailable: readonly DiagnosticUnknown[];
}

export interface ResourceContentionDiagnostic {
  readonly scope: ExecutionDiagnosticScope;
  readonly rows: readonly {
    runId: string;
    instrumentId: string;
    orderId: string;
    quoteEvidenceId: string;
    side: BookSide;
    canonicalRank: number | null;
    requestedShares: number | null;
    filledShares: number;
    remainingOwnedShares: number | null;
    initialBudgetShares: number | null;
    remainingBudgetBeforeOrder: number | null;
    reason:
      | "RECORDED_REASON"
      | "CAPACITY_BOUND_CONFIRMED"
      | "FILLED"
      | "PARTIAL_FILL"
      | "UNAVAILABLE";
    recordedReason: string | null;
    unavailable: readonly DiagnosticUnknown[];
  }[];
}
