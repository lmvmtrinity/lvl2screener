import {
  applyEntryOrderQuote,
  type PendingEntryOrder,
} from "./pending-order.js";
import { classifyQuoteAvailability } from "./quote-execution.js";
import type { QuoteFact } from "./types.js";

export interface EntryLiquidityState {
  readonly instrumentId: string;
  readonly quote: QuoteFact;
  readonly availableShares: number;
  readonly consumedShares: number;
  readonly consumedBidShares: number;
  readonly participation: number;
  readonly impactBps: number;
  readonly processedOrderIds: readonly string[];
}

export function openEntryLiquidity(
  instrumentId: string,
  quote: QuoteFact,
  participation: number,
  impactBps: number,
): EntryLiquidityState {
  if (
    !instrumentId ||
    classifyQuoteAvailability(quote, quote.timestamp, 0) !== null
  )
    throw new Error("Shared liquidity requires an identified, valid quote");
  if (
    !Number.isFinite(participation) ||
    participation <= 0 ||
    participation > 1 ||
    !Number.isFinite(impactBps) ||
    impactBps < 0 ||
    impactBps > 10000
  )
    throw new Error("Invalid shared liquidity assumptions");
  return {
    instrumentId,
    quote: structuredClone(quote),
    participation,
    impactBps,
    availableShares: Math.floor(quote.askSize * participation),
    consumedShares: 0,
    consumedBidShares: 0,
    processedOrderIds: [],
  };
}

export function allocateEntryLiquidity(
  liquidity: EntryLiquidityState,
  instrumentId: string,
  orders: readonly PendingEntryOrder[],
): { liquidity: EntryLiquidityState; orders: PendingEntryOrder[] } {
  if (instrumentId !== liquidity.instrumentId)
    throw new Error("Liquidity instrument mismatch");
  if (new Set(orders.map((order) => order.orderId)).size !== orders.length)
    throw new Error("Duplicate order IDs in allocation batch");
  const ordered = [...orders].sort(
    (left, right) =>
      Date.parse(left.releaseAt) - Date.parse(right.releaseAt) ||
      Date.parse(left.submittedAt) - Date.parse(right.submittedAt) ||
      (left.orderId < right.orderId
        ? -1
        : left.orderId > right.orderId
          ? 1
          : 0),
  );
  let consumedShares = liquidity.consumedShares;
  const processed = new Set(liquidity.processedOrderIds);
  const results = new Map<string, PendingEntryOrder>();
  for (const order of ordered) {
    if (
      order.status !== "PENDING" ||
      processed.has(order.orderId) ||
      Date.parse(order.releaseAt) > Date.parse(liquidity.quote.timestamp)
    ) {
      results.set(order.orderId, order);
      continue;
    }
    const remaining = liquidity.availableShares - consumedShares;
    const slippageBps = order.assumptions.slippageBps + liquidity.impactBps;
    const executable = {
      ...order,
      assumptions: {
        ...order.assumptions,
        executionMode: "CAPACITY_CONSTRAINED" as const,
        slippageBps,
        ...(order.assumptions.costs
          ? { costs: { ...order.assumptions.costs, slippageBps } }
          : {}),
      },
      context: {
        ...order.context,
        executionMode: "CAPACITY_CONSTRAINED" as const,
        displayedSize: remaining,
        maxDisplayedSizeParticipation: 1,
      },
    };
    const evaluated = applyEntryOrderQuote(executable, {
      ...liquidity.quote,
      askSize: remaining,
    });
    const next = {
      ...evaluated,
      assumptions: order.assumptions,
      context: order.context,
    };
    if (next.status === "FILLED" && next.execution?.status === "OPEN") {
      const shares = next.execution.position.shares;
      if (!Number.isSafeInteger(shares) || shares < 1 || shares > remaining)
        throw new Error("Shared quote capacity exceeded");
      consumedShares += shares;
    }
    processed.add(order.orderId);
    results.set(order.orderId, next);
  }
  return {
    liquidity: {
      ...liquidity,
      consumedShares,
      processedOrderIds: [...processed],
    },
    orders: orders.map((order) => results.get(order.orderId)!),
  };
}
