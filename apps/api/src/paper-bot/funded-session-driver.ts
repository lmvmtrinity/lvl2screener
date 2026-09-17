import type { FundedOrderService } from "./funded-order-service.js";
import { FundedRiskVeto, type FundedRiskVetoCode } from "./funded-ledger.js";

export type FundedSessionFact =
  | { type: "CLOCK"; at: string }
  | {
      type: "SIGNAL";
      instrumentId: string;
      order: Parameters<FundedOrderService["submit"]>[1];
      maximumDebit: number;
      maximumRisk: number;
    }
  | {
      type: "QUOTE";
      instrumentId: string;
      quote: Parameters<FundedOrderService["quote"]>[1];
      participation: number;
      impactBps: number;
    }
  | {
      type: "CANCEL";
      orderId: string;
      at: string;
      reason: Parameters<FundedOrderService["cancel"]>[2];
      /** Present only for a durable pre-submission invalidation suppression. */
      preSubmissionEventId?: string;
    };

export function factTime(fact: FundedSessionFact): number {
  const value = Date.parse(
    fact.type === "SIGNAL"
      ? fact.order.submittedAt
      : fact.type === "QUOTE"
        ? fact.quote.timestamp
        : fact.at,
  );
  if (!Number.isFinite(value))
    throw new Error("Invalid funded session fact time");
  return value;
}
export function factKey(fact: FundedSessionFact): string {
  return fact.type === "CLOCK"
    ? ""
    : fact.type === "QUOTE"
      ? fact.instrumentId
      : fact.type === "SIGNAL"
        ? fact.order.orderId
        : fact.orderId;
}

export const factPriority = {
  CANCEL: 0,
  CLOCK: 1,
  SIGNAL: 2,
  QUOTE: 3,
} as const;

/**
 * One inbox fact together with the durable envelope identity that caused its
 * effects. The driver persists that identity on every order revision and
 * ledger event it writes, so replay terminality and outcome provenance can bind
 * the exact causing fact rather than an inferred timestamp. Envelope identities
 * are optional only for legacy/direct callers; replay economics without one
 * remain untrainable rather than borrowing another boundary.
 */
export interface FundedSessionFactInput {
  readonly fact: FundedSessionFact;
  readonly factId?: string;
}

export async function processFundedSessionFacts(
  service: Pick<
    FundedOrderService,
    "submit" | "quote" | "cancel" | "advanceClock"
  >,
  inputs: readonly FundedSessionFactInput[],
): Promise<{
  processed: number;
  reservationVetoes: {
    orderId: string;
    reason: string;
    code: FundedRiskVetoCode;
  }[];
  cancellationNoOps: {
    orderId: string;
    reason: "RESERVATION_VETO" | "PRE_SUBMISSION_INVALIDATION";
  }[];
}> {
  const ordered = inputs
    .map((input) => ({ ...input, time: factTime(input.fact) }))
    .sort(
      (left, right) =>
        left.time - right.time ||
        factPriority[left.fact.type] - factPriority[right.fact.type] ||
        (factKey(left.fact) < factKey(right.fact)
          ? -1
          : factKey(left.fact) > factKey(right.fact)
            ? 1
            : 0),
    );
  const reservationVetoes: {
    orderId: string;
    reason: string;
    code: FundedRiskVetoCode;
  }[] = [];
  const cancellationNoOps: {
    orderId: string;
    reason: "RESERVATION_VETO" | "PRE_SUBMISSION_INVALIDATION";
  }[] = [];
  let processed = 0;
  for (const { fact, factId } of ordered) {
    if (fact.type === "SIGNAL") {
      try {
        await service.submit(
          fact.instrumentId,
          fact.order,
          fact.maximumDebit,
          fact.maximumRisk,
          factId,
        );
      } catch (error) {
        if (!(error instanceof FundedRiskVeto)) throw error;
        reservationVetoes.push({
          orderId: fact.order.orderId,
          reason: error.message,
          code: error.code,
        });
      }
    } else if (fact.type === "CLOCK") {
      await service.advanceClock(fact.at, factId);
    } else if (fact.type === "CANCEL") {
      const result = await service.cancel(
        fact.orderId,
        fact.at,
        fact.reason,
        fact.preSubmissionEventId,
        factId,
      );
      if (result.status === "NO_OP")
        cancellationNoOps.push({
          orderId: fact.orderId,
          reason: result.reason,
        });
    } else {
      await service.quote(
        fact.instrumentId,
        fact.quote,
        fact.participation,
        fact.impactBps,
        factId,
      );
    }
    processed += 1;
  }
  return { processed, reservationVetoes, cancellationNoOps };
}
