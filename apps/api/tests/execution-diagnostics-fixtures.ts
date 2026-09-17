import type {
  DiagnosticAllocationInput,
  DiagnosticFill,
  DiagnosticQuote,
  ExecutionDiagnosticEvidence,
  ExecutionDiagnosticScope,
} from "../src/paper-bot/execution-diagnostics-types.js";

export const scope: ExecutionDiagnosticScope = {
  marketId: "CA_TSX",
  currency: "CAD",
  accountId: "account",
  selectedRunId: "run",
  runIds: ["run"],
  temporalScope: "RUN_END",
  asOf: "2099-04-01T21:00:00.000Z",
};

export const diagnosticQuote = (
  evidenceId: string,
  at: string,
  bidSize = 100,
  askSize = 100,
): DiagnosticQuote => ({
  runId: "run",
  instrumentId: "instrument",
  evidenceId,
  quote: {
    timestamp: at,
    bid: 9.99,
    ask: 10,
    bidSize,
    askSize,
    dataStatus: "REALTIME",
    actionable: true,
    sizeUnit: "SHARES",
  },
  decisionAt: at,
  maxQuoteAgeSeconds: 30,
  participation: 1,
  source: "FUNDED_FACT",
});

export const diagnosticFill = (
  eventId: string,
  quote: DiagnosticQuote,
  shares: number,
  side: "BID" | "ASK" = "ASK",
): DiagnosticFill => ({
  runId: "run",
  instrumentId: "instrument",
  orderId: eventId,
  eventId,
  eventSequence: Number(eventId.slice(1)),
  at: quote.quote.timestamp,
  side,
  shares,
  quoteEvidenceId: quote.evidenceId,
  linkUnknown: null,
});

export const diagnosticEvidence = (
  quotes: DiagnosticQuote[],
  fills: DiagnosticFill[],
  allocations: DiagnosticAllocationInput[] = [],
): ExecutionDiagnosticEvidence => ({
  scope,
  quotes,
  fills,
  allocations,
  unavailable: [],
});

export const allocation = (
  orderId: string,
  quoteEvidenceId: string,
): DiagnosticAllocationInput => ({
  runId: "run",
  instrumentId: "instrument",
  orderId,
  quoteEvidenceId,
  side: "ASK",
  submittedAt: "2099-04-01T14:30:00.000Z",
  releaseAt: "2099-04-01T14:30:00.000Z",
  requestedShares: 60,
  beforeShares: null,
  afterShares: null,
  explicitReason: null,
  completeness: "EXACT",
});
