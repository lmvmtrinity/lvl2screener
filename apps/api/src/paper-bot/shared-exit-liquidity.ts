import type { FundedPortfolioPolicy } from "./funded-policy.js";
import {
  applyQuoteFact,
  requestQuoteSessionClose,
  requestQuoteTimeStop,
} from "./execution-core.js";
import type { PendingEntryOrder } from "./pending-order.js";
import { classifyQuoteAvailability } from "./quote-execution.js";
import type { QuoteFact } from "./types.js";

export function allocateExitLiquidity(
  orders: readonly PendingEntryOrder[],
  quote: QuoteFact,
  participation: number,
  impactBps: number,
  sessionCloseAt?: string,
  portfolio?: FundedPortfolioPolicy,
): { orders: PendingEntryOrder[]; consumedShares: number } {
  if (
    classifyQuoteAvailability(quote, quote.timestamp, 0) !== null ||
    !Number.isFinite(participation) ||
    participation <= 0 ||
    participation > 1 ||
    !Number.isFinite(impactBps) ||
    impactBps < 0 ||
    impactBps > 10000
  )
    throw new Error("Invalid shared exit quote or assumptions");
  if (
    sessionCloseAt !== undefined &&
    !Number.isFinite(Date.parse(sessionCloseAt))
  )
    throw new Error("Invalid session close boundary");
  if (new Set(orders.map((order) => order.orderId)).size !== orders.length)
    throw new Error("Duplicate exit order ID");
  let remaining = Math.floor(quote.bidSize * participation);
  const capacity = remaining;
  const updated = new Map<string, PendingEntryOrder>();
  const sorted = [...orders].sort(
    (left, right) =>
      Date.parse(left.submittedAt) - Date.parse(right.submittedAt) ||
      (left.orderId < right.orderId
        ? -1
        : left.orderId > right.orderId
          ? 1
          : 0),
  );
  for (const order of sorted) {
    const execution = order.execution;
    if (
      order.status !== "FILLED" ||
      !execution ||
      (execution.status !== "OPEN" && execution.status !== "CLOSE_PENDING")
    )
      continue;
    const before =
      execution.position.remainingShares ?? execution.position.shares;
    const assumptions = {
      ...order.assumptions,
      slippageBps: order.assumptions.slippageBps + impactBps,
    };
    const fact = { ...quote, bidSize: remaining };
    const constrained = {
      ...execution,
      position: {
        ...execution.position,
        executionMode: "CAPACITY_CONSTRAINED" as const,
      },
    };
    const close =
      execution.status === "CLOSE_PENDING" ||
      (sessionCloseAt !== undefined &&
        Date.parse(quote.timestamp) >= Date.parse(sessionCloseAt));
    const elapsedMinutes =
      (Date.parse(quote.timestamp) - Date.parse(execution.position.entryTime)) /
      60_000;
    const context = portfolio
      ? {
          strategyKey: order.context?.strategyKey,
          maximumHoldingMinutes:
            portfolio.maximumHoldingMinutesByStrategy?.[
              order.context?.strategyKey ?? ""
            ] ?? portfolio.maximumHoldingMinutes,
          stalledBreakoutMinutes: portfolio.stalledBreakoutMinutes,
          stalledBreakoutMinProgressR: portfolio.stalledBreakoutMinProgressR,
        }
      : order.context;
    const riskPerShare =
      execution.position.entryPrice - execution.position.stop;
    const breakout = [
      "ORB_RETEST",
      "HIGH_OF_DAY_BREAKOUT",
      "PRIOR_DAY_HIGH_BREAKOUT",
      "BULL_FLAG",
    ].includes(context?.strategyKey ?? "");
    const stalled =
      breakout &&
      context?.stalledBreakoutMinutes !== undefined &&
      elapsedMinutes >= context.stalledBreakoutMinutes &&
      riskPerShare > 0 &&
      (quote.bid - execution.position.entryPrice) / riskPerShare <
        (context.stalledBreakoutMinProgressR ?? 0);
    const timedOut =
      (context?.maximumHoldingMinutes !== undefined &&
        elapsedMinutes >= context.maximumHoldingMinutes) ||
      stalled;
    const timeExit =
      timedOut &&
      !execution.position.pendingExitReason &&
      quote.bid > execution.position.stop &&
      quote.bid < execution.position.target;
    const next = close
      ? requestQuoteSessionClose(
          constrained,
          sessionCloseAt ?? execution.lastFactTimestamp,
          fact,
          assumptions,
        ).state
      : timeExit
        ? requestQuoteTimeStop(
            {
              ...constrained,
              position: {
                ...constrained.position,
                pendingExitReason: "TIME_STOP",
              },
            },
            fact,
            assumptions,
          ).state
        : applyQuoteFact(constrained, fact, assumptions).state;
    if (
      next.status === "OPEN" ||
      next.status === "CLOSE_PENDING" ||
      next.status === "CLOSED"
    ) {
      const after =
        next.status === "CLOSED"
          ? 0
          : (next.position.remainingShares ?? next.position.shares);
      const filled = before - after;
      if (!Number.isSafeInteger(filled) || filled < 0 || filled > remaining)
        throw new Error("Shared bid capacity exceeded");
      remaining -= filled;
    }
    updated.set(order.orderId, { ...order, execution: next });
  }
  return {
    orders: orders.map((order) => updated.get(order.orderId) ?? order),
    consumedShares: capacity - remaining,
  };
}
