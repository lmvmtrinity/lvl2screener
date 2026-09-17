import {
  FUNDED_COMPARISON_MARK_AGE_MS,
  inputItemEffectiveAt,
  inputItemOrderKey,
  type FundedComparisonFailureReason,
  type FundedComparisonInputItem,
} from "@tsx-scanner/contracts";
import {
  applyLedgerEvent,
  fundedAccountSummary,
  type FundedLedger,
  type LedgerEvent,
} from "./funded-ledger.js";

/**
 * ADR-016 §4.2 union-grid mark-to-market valuation (FP03). Pure and
 * deterministic: no database access, no wall clock, no current-state read.
 *
 * Each side is reconstructed from its retained session-start ledger state plus
 * the ordered ledger events the funded path actually applied. An event is
 * applied to its own side before any grid point at or after its effective time
 * is valued; database insertion time never orders or selects an event.
 */

export type FundedComparisonValuationOwner =
  "SHARED" | "CHAMPION" | "CHALLENGER";

export interface FundedComparisonValuationEffect {
  readonly at: string;
  /** Retained causal sequence (`paper_funded_event.event_sequence`). */
  readonly sequence: number;
  readonly event: LedgerEvent;
}

export interface FundedComparisonValuationGridPoint {
  readonly at: string;
  readonly owner: FundedComparisonValuationOwner;
  readonly causalKey: string;
}

export interface FundedComparisonValuationGrid {
  readonly points: readonly FundedComparisonValuationGridPoint[];
}

export interface FundedComparisonValuationSide {
  /** Ledger state proven at the session boundary, before the session's effects. */
  readonly initialState: FundedLedger;
  readonly effects: readonly FundedComparisonValuationEffect[];
}

export interface FundedComparisonValuationInput {
  readonly sharedInputs: readonly FundedComparisonInputItem[];
  readonly champion: FundedComparisonValuationSide;
  readonly challenger: FundedComparisonValuationSide;
  readonly initialCash: number;
}

export interface FundedComparisonSideValuation {
  readonly equityPoints: readonly { at: string; equity: number }[];
  readonly maxDrawdown: number | null;
  readonly maxDrawdownPctOfInitialCash: number | null;
  readonly staleMarkPoints: number;
  readonly integrityFindings: readonly string[];
  readonly status: "PROVEN" | "UNAVAILABLE";
  readonly reason: FundedComparisonFailureReason | null;
}

export interface FundedComparisonValuation {
  readonly champion: FundedComparisonSideValuation;
  readonly challenger: FundedComparisonSideValuation;
  readonly grid: FundedComparisonValuationGrid;
}

function unavailableSide(
  reason: FundedComparisonFailureReason,
  finding: string,
): FundedComparisonSideValuation {
  return {
    equityPoints: [],
    maxDrawdown: null,
    maxDrawdownPctOfInitialCash: null,
    staleMarkPoints: 0,
    integrityFindings: [finding],
    status: "UNAVAILABLE",
    reason,
  };
}

function verifyEffects(side: FundedComparisonValuationSide): string | null {
  let previous = 0;
  for (const effect of side.effects) {
    if (
      !Number.isSafeInteger(effect.sequence) ||
      effect.sequence <= previous ||
      !Number.isFinite(Date.parse(effect.at))
    )
      return `Effect sequence ${effect.sequence} is not a proven monotone causal order`;
    previous = effect.sequence;
  }
  return null;
}

/**
 * Ordered union of the shared exogenous times and both sides' endogenous
 * effect times. Shared CLOCK/SIGNAL/QUOTE/CANCEL precedence follows the frozen
 * `CANCEL < CLOCK < SIGNAL < QUOTE` order through the canonical item key.
 */
export function buildUnionValuationGrid(input: {
  sharedInputs: readonly FundedComparisonInputItem[];
  championEffects: readonly FundedComparisonValuationEffect[];
  challengerEffects: readonly FundedComparisonValuationEffect[];
}): FundedComparisonValuationGrid {
  const points: FundedComparisonValuationGridPoint[] = [
    ...input.sharedInputs.map((item) => ({
      at: inputItemEffectiveAt(item),
      owner: "SHARED" as const,
      causalKey: inputItemOrderKey(item),
    })),
    ...input.championEffects.map((effect) => ({
      at: effect.at,
      owner: "CHAMPION" as const,
      causalKey: `${effect.at}|7|${effect.sequence.toString().padStart(20, "0")}`,
    })),
    ...input.challengerEffects.map((effect) => ({
      at: effect.at,
      owner: "CHALLENGER" as const,
      causalKey: `${effect.at}|7|${effect.sequence.toString().padStart(20, "0")}`,
    })),
  ];
  points.sort((left, right) =>
    left.causalKey < right.causalKey
      ? -1
      : left.causalKey > right.causalKey
        ? 1
        : left.owner.localeCompare(right.owner),
  );
  const deduped: FundedComparisonValuationGridPoint[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    const key = `${point.owner}|${point.causalKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
  }
  return { points: deduped };
}

function valueSide(
  side: FundedComparisonValuationSide,
  initialCash: number,
  grid: FundedComparisonValuationGrid,
): FundedComparisonSideValuation {
  let state = side.initialState;
  let cursor = 0;
  const equityPoints: { at: string; equity: number }[] = [];
  let staleMarkPoints = 0;
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdown = 0;
  for (const point of grid.points) {
    while (
      cursor < side.effects.length &&
      Date.parse(side.effects[cursor]!.at) <= Date.parse(point.at)
    ) {
      state = applyLedgerEvent(state, side.effects[cursor]!.event);
      cursor += 1;
    }
    const summary = fundedAccountSummary(
      state,
      point.at,
      FUNDED_COMPARISON_MARK_AGE_MS,
    );
    if (summary.staleMarks) {
      staleMarkPoints += 1;
      continue;
    }
    equityPoints.push({ at: point.at, equity: summary.equity });
    if (summary.equity > peak) peak = summary.equity;
    if (Number.isFinite(peak)) {
      const drawdown = peak - summary.equity;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }
  if (staleMarkPoints > 0)
    return unavailableSide(
      "STALE_MARK",
      `${staleMarkPoints} grid point(s) had no mark within ${FUNDED_COMPARISON_MARK_AGE_MS}ms`,
    );
  if (cursor !== side.effects.length)
    return unavailableSide(
      "UNPROVABLE_CAUSAL_ORDER",
      "A retained effect is effective after the final grid point",
    );
  if (!(initialCash > 0))
    return unavailableSide(
      "RISK_IDENTITY_MISMATCH",
      "The frozen initial cash is not a positive amount",
    );
  return {
    equityPoints,
    maxDrawdown,
    maxDrawdownPctOfInitialCash: maxDrawdown / initialCash,
    staleMarkPoints,
    integrityFindings: [],
    status: "PROVEN",
    reason: null,
  };
}

export function reconstructComparisonValuation(
  input: FundedComparisonValuationInput,
): FundedComparisonValuation {
  const grid = buildUnionValuationGrid({
    sharedInputs: input.sharedInputs,
    championEffects: input.champion.effects,
    challengerEffects: input.challenger.effects,
  });
  if (
    input.champion.initialState.currency !==
    input.challenger.initialState.currency
  ) {
    const reason = "MARKET_CURRENCY_MISMATCH" as const;
    return {
      champion: unavailableSide(reason, "Champion currency mismatch"),
      challenger: unavailableSide(reason, "Challenger currency mismatch"),
      grid,
    };
  }
  const championFinding = verifyEffects(input.champion);
  if (championFinding)
    return {
      champion: unavailableSide("UNPROVABLE_CAUSAL_ORDER", championFinding),
      challenger: unavailableSide("UNPROVABLE_CAUSAL_ORDER", championFinding),
      grid,
    };
  const challengerFinding = verifyEffects(input.challenger);
  if (challengerFinding)
    return {
      champion: unavailableSide("UNPROVABLE_CAUSAL_ORDER", challengerFinding),
      challenger: unavailableSide("UNPROVABLE_CAUSAL_ORDER", challengerFinding),
      grid,
    };
  if (input.sharedInputs.length === 0) {
    const reason = "RETAINED_INPUT_MISSING" as const;
    return {
      champion: unavailableSide(reason, "No retained shared input"),
      challenger: unavailableSide(reason, "No retained shared input"),
      grid,
    };
  }
  return {
    champion: valueSide(input.champion, input.initialCash, grid),
    challenger: valueSide(input.challenger, input.initialCash, grid),
    grid,
  };
}

/** The exact fail-closed receipt for an unavailable comparison window. */
export function comparisonWindowUnavailable(
  reason: FundedComparisonFailureReason,
): { status: "UNAVAILABLE"; reason: FundedComparisonFailureReason } {
  return { status: "UNAVAILABLE", reason };
}
