import { isDeepStrictEqual } from "node:util";
import type { FundedComparisonVetoReason } from "@tsx-scanner/contracts";

/**
 * Stable structured funded risk-veto code. The exact existing message and
 * condition remain unchanged; the code is a classification-only addition so
 * comparison evidence never has to parse a message.
 */
export type FundedRiskVetoCode = FundedComparisonVetoReason;

export class FundedRiskVeto extends Error {
  constructor(
    readonly orderId: string,
    message: string,
    readonly code: FundedRiskVetoCode,
  ) {
    super(message);
    this.name = "FundedRiskVeto";
  }
}

export interface FundedPosition {
  readonly instrumentId: string;
  readonly shares: number;
  readonly basis: number;
  readonly stop: number;
  readonly mark: number;
  readonly markedAt: string;
}

export interface FundedLedger {
  readonly version: "funded-ledger-v1";
  readonly currency: "CAD" | "USD";
  readonly cash: number;
  readonly session: string;
  readonly openingEquity: number;
  readonly dailyLossLimit: number;
  readonly realizedPnl: number;
  readonly positions: Readonly<Record<string, FundedPosition>>;
  readonly reservations: Readonly<
    Record<string, { debit: number; risk: number }>
  >;
  readonly events: readonly LedgerEvent[];
  readonly lastEventAt: string;
}

interface EventBase {
  readonly id: string;
  readonly at: string;
  readonly currency: "CAD" | "USD";
}
export type LedgerEvent = EventBase &
  (
    | { type: "RESERVE"; orderId: string; debit: number; risk: number }
    | { type: "RELEASE"; orderId: string }
    | {
        type: "BUY";
        orderId: string;
        positionId: string;
        instrumentId: string;
        shares: number;
        price: number;
        fee: number;
        stop: number;
      }
    | {
        type: "SELL";
        positionId: string;
        shares: number;
        price: number;
        fee: number;
      }
    | { type: "MARK"; instrumentId: string; bid: number }
    | { type: "SESSION"; session: string }
  );

function money(value: number): number {
  const units = Math.round(value * 10000);
  if (!Number.isFinite(value) || !Number.isSafeInteger(units))
    throw new Error("Invalid ledger amount");
  return units / 10000;
}
function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("Expected positive ledger value");
  return value;
}
function time(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid ledger time");
  return parsed;
}

export function createFundedLedger(
  currency: "CAD" | "USD",
  cash: number,
  session: string,
  at: string,
  dailyLossLimit: number,
): FundedLedger {
  positive(cash);
  positive(dailyLossLimit);
  time(at);
  if (!session) throw new Error("Session is required");
  return {
    version: "funded-ledger-v1",
    currency,
    cash: money(cash),
    session,
    openingEquity: money(cash),
    dailyLossLimit: money(dailyLossLimit),
    realizedPnl: 0,
    positions: {},
    reservations: {},
    events: [],
    lastEventAt: at,
  };
}

export function fundedAccountSummary(
  ledger: FundedLedger,
  at: string,
  maxMarkAgeMs: number,
) {
  if (!Number.isFinite(maxMarkAgeMs) || maxMarkAgeMs < 0)
    throw new Error("Invalid mark age limit");
  const now = time(at);
  if (now < time(ledger.lastEventAt))
    throw new Error("Summary precedes ledger");
  const positions = Object.values(ledger.positions);
  const marketValue = money(
    positions.reduce(
      (total, position) => total + position.shares * position.mark,
      0,
    ),
  );
  const basis = money(
    positions.reduce((total, position) => total + position.basis, 0),
  );
  const reservedCash = money(
    Object.values(ledger.reservations).reduce(
      (total, reservation) => total + reservation.debit,
      0,
    ),
  );
  const reservedRisk = money(
    Object.values(ledger.reservations).reduce(
      (total, reservation) => total + reservation.risk,
      0,
    ),
  );
  const openRisk = money(
    positions.reduce(
      (total, position) =>
        total + Math.max(0, position.mark - position.stop) * position.shares,
      0,
    ),
  );
  const equity = money(ledger.cash + marketValue);
  const dailyPnl = money(equity - ledger.openingEquity);
  const staleMarks = positions.some(
    (position) => now - time(position.markedAt) > maxMarkAgeMs,
  );
  const remainingDailyRisk = money(
    Math.max(
      0,
      ledger.dailyLossLimit - Math.max(0, -dailyPnl) - openRisk - reservedRisk,
    ),
  );
  return {
    cash: ledger.cash,
    equity,
    marketValue,
    buyingPower: money(Math.max(0, ledger.cash - reservedCash)),
    reservedCash,
    reservedRisk,
    openRisk,
    unrealizedPnl: money(marketValue - basis),
    realizedPnl: ledger.realizedPnl,
    dailyPnl,
    remainingDailyRisk,
    staleMarks,
    entriesAllowed: !staleMarks && dailyPnl > -ledger.dailyLossLimit,
  };
}

export function applyLedgerEvent(
  ledger: FundedLedger,
  event: LedgerEvent,
  maxMarkAgeMs = 30000,
): FundedLedger {
  if (!event.id || event.currency !== ledger.currency)
    throw new Error("Missing event identity or currency mismatch");
  const prior = ledger.events.find((candidate) => candidate.id === event.id);
  if (prior) {
    if (!isDeepStrictEqual(prior, event))
      throw new Error("Conflicting ledger event retry");
    return ledger;
  }
  if (time(event.at) < time(ledger.lastEventAt))
    throw new Error("Out-of-order ledger event");
  // Shallow structural copy instead of a deep clone: cash, session and marks
  // are scalars, and positions, reservations and events are only ever replaced
  // wholesale below, so the prior state stays byte-identical without paying a
  // full deep copy of the retained event history on every event.
  const next: FundedLedger = {
    ...ledger,
    positions: { ...ledger.positions },
    reservations: { ...ledger.reservations },
    events: [...ledger.events],
  };
  const positions = { ...next.positions };
  const reservations = { ...next.reservations };
  let cash = next.cash;
  let realizedPnl = next.realizedPnl;
  let openingEquity = next.openingEquity;
  let session = next.session;
  const summary = fundedAccountSummary(ledger, event.at, maxMarkAgeMs);
  if (event.type === "RESERVE") {
    const debit = money(positive(event.debit));
    const risk = money(positive(event.risk));
    if (!event.orderId || reservations[event.orderId])
      throw new Error("Duplicate or missing reservation");
    if (
      !summary.entriesAllowed ||
      debit > summary.buyingPower ||
      risk > summary.remainingDailyRisk
    )
      throw new FundedRiskVeto(
        event.orderId,
        "Funded account risk or buying power veto",
        "DAILY_LOSS_OR_BUYING_POWER",
      );
    reservations[event.orderId] = { debit, risk };
  } else if (event.type === "RELEASE") {
    delete reservations[event.orderId];
  } else if (event.type === "BUY" || event.type === "SELL") {
    if (
      !Number.isSafeInteger(event.shares) ||
      event.shares < 1 ||
      event.fee < 0
    )
      throw new Error("Invalid fill quantity or fee");
    positive(event.price);
    money(event.fee);
    const value = money(event.price * event.shares);
    if (event.type === "BUY") {
      positive(event.stop);
      const reservation = reservations[event.orderId];
      const debit = money(value + event.fee);
      const risk = money((event.price - event.stop) * event.shares + event.fee);
      if (
        !event.positionId ||
        !event.instrumentId ||
        positions[event.positionId] ||
        !reservation ||
        event.stop >= event.price
      )
        throw new Error("Invalid funded entry");
      const currentRiskCapacity =
        ledger.dailyLossLimit -
        Math.max(0, -summary.dailyPnl) -
        summary.openRisk -
        summary.reservedRisk +
        reservation.risk;
      if (
        !summary.entriesAllowed ||
        debit > reservation.debit ||
        debit > cash ||
        risk > reservation.risk ||
        risk > currentRiskCapacity
      )
        throw new FundedRiskVeto(
          event.orderId,
          "Fill exceeds funded reservation",
          "FILL_EXCEEDS_RESERVATION",
        );
      cash = money(cash - debit);
      positions[event.positionId] = {
        instrumentId: event.instrumentId,
        shares: event.shares,
        basis: debit,
        stop: event.stop,
        mark: event.price,
        markedAt: event.at,
      };
      delete reservations[event.orderId];
    } else {
      const position = positions[event.positionId];
      if (!position || event.shares > position.shares)
        throw new Error("Sell exceeds owned quantity");
      const basis =
        event.shares === position.shares
          ? position.basis
          : money((position.basis * event.shares) / position.shares);
      cash = money(cash + value - event.fee);
      realizedPnl = money(realizedPnl + value - event.fee - basis);
      if (event.shares === position.shares) delete positions[event.positionId];
      else
        positions[event.positionId] = {
          ...position,
          shares: position.shares - event.shares,
          basis: money(position.basis - basis),
        };
    }
  } else if (event.type === "MARK") {
    positive(event.bid);
    for (const [id, position] of Object.entries(positions))
      if (position.instrumentId === event.instrumentId)
        positions[id] = { ...position, mark: event.bid, markedAt: event.at };
  } else {
    if (
      !event.session ||
      event.session <= session ||
      summary.staleMarks ||
      Object.keys(reservations).length
    )
      throw new Error(
        "Session rollover requires fresh marks, no reservations and a later session",
      );
    session = event.session;
    openingEquity = summary.equity;
    realizedPnl = 0;
  }
  return {
    ...next,
    cash,
    positions,
    reservations,
    realizedPnl,
    session,
    openingEquity,
    events: [...next.events, structuredClone(event)],
    lastEventAt: event.at,
  };
}
