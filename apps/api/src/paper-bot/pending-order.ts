import {
  createQuoteExecution,
  type QuoteExecutionState,
} from "./execution-core.js";
import { classifyQuoteAvailability } from "./quote-execution.js";
import type {
  AssumptionsSnapshot,
  QuoteFact,
  SignalFact,
  SizingContext,
} from "./types.js";

export interface PendingEntryOrder {
  readonly version: "pending-entry-v1";
  readonly orderId: string;
  readonly status: "PENDING" | "FILLED" | "CANCELLED" | "REJECTED";
  readonly signal: SignalFact;
  readonly assumptions: AssumptionsSnapshot;
  readonly context?: SizingContext;
  readonly submittedAt: string;
  readonly releaseAt: string;
  readonly expiresAt: string;
  readonly lastQuoteAt: string | null;
  readonly execution: QuoteExecutionState | null;
  readonly reason: string | null;
}

function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("Invalid order timestamp");
  return result;
}

export function submitEntryOrder(input: {
  orderId: string;
  signal: SignalFact;
  assumptions: AssumptionsSnapshot;
  context?: SizingContext;
  submittedAt: string;
  expiresAt: string;
}): PendingEntryOrder {
  const submitted = timestamp(input.submittedAt);
  const latency = input.context?.latencyMs ?? input.assumptions.latencyMs ?? 0;
  if (!input.orderId || !Number.isSafeInteger(latency) || latency < 0)
    throw new Error("Order ID and non-negative integer latency are required");
  if (submitted < timestamp(input.signal.signalTimestamp))
    throw new Error("Order submission precedes signal");
  const releaseAt = new Date(submitted + latency).toISOString();
  if (timestamp(input.expiresAt) <= timestamp(releaseAt))
    throw new Error("Order must expire after release");
  return {
    ...structuredClone(input),
    version: "pending-entry-v1",
    status: "PENDING",
    releaseAt,
    lastQuoteAt: null,
    execution: null,
    reason: null,
  };
}

export function cancelEntryOrder(
  order: PendingEntryOrder,
  at: string,
  reason:
    "USER_CANCELLED" | "SIGNAL_INVALIDATED" | "SESSION_CLOSED" | "RISK_VETO",
): PendingEntryOrder {
  if (
    timestamp(at) < timestamp(order.submittedAt) ||
    (order.lastQuoteAt !== null && timestamp(at) < timestamp(order.lastQuoteAt))
  )
    throw new Error("Cancellation precedes processed order facts");
  return order.status === "PENDING"
    ? { ...order, status: "CANCELLED", reason }
    : order;
}

export function expireEntryOrder(
  order: PendingEntryOrder,
  at: string,
): PendingEntryOrder {
  if (order.status !== "PENDING" || timestamp(at) < timestamp(order.expiresAt))
    return order;
  return { ...order, status: "CANCELLED", reason: "EXPIRED" };
}

export function applyEntryOrderQuote(
  order: PendingEntryOrder,
  quote: QuoteFact,
): PendingEntryOrder {
  if (order.status !== "PENDING") return order;
  const quotedAt = timestamp(quote.timestamp);
  if (
    quotedAt < timestamp(order.releaseAt) ||
    (order.lastQuoteAt !== null && quotedAt <= timestamp(order.lastQuoteAt))
  )
    return order;
  const expired = expireEntryOrder(order, quote.timestamp);
  if (expired !== order) return expired;
  if (classifyQuoteAvailability(quote, quote.timestamp, 0) !== null)
    return order;
  const execution = createQuoteExecution(
    order.signal,
    quote,
    { ...order.assumptions, latencyMs: 0 },
    order.context ? { ...order.context, latencyMs: 0 } : undefined,
    quote.timestamp,
  );
  if (
    execution.status === "NO_FILL" &&
    execution.noFillReason === "SHARES_BELOW_ONE"
  )
    return { ...order, lastQuoteAt: quote.timestamp };
  if (execution.status !== "OPEN")
    return {
      ...order,
      status: "REJECTED",
      lastQuoteAt: quote.timestamp,
      execution,
      reason: execution.status,
    };
  const latencyMs = timestamp(order.releaseAt) - timestamp(order.submittedAt);
  return {
    ...order,
    status: "FILLED",
    lastQuoteAt: quote.timestamp,
    execution: {
      ...execution,
      position: {
        ...execution.position,
        decisionTime: order.submittedAt,
        latencyMs,
      },
      entryMarketSnapshot: {
        ...execution.entryMarketSnapshot,
        decisionTimestamp: order.submittedAt,
        latencyMs,
      },
    },
    reason: null,
  };
}
