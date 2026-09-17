/**
 * Shared types for the paper-bot execution core (private development record
 * Phase 2). This module has no database, clock, or network access: every
 * function here is a pure transformation over explicit inputs.
 */

export type ExecutionModel = "QUOTE" | "CANDLE";

export type ExecutionMode = "UNCONSTRAINED" | "CAPACITY_CONSTRAINED";

export type StopMethod = "STRUCTURAL" | "ATR";

export type NoFillReason =
  | "HALTED"
  | "DELAYED"
  | "STALE"
  | "MISSING_QUOTE"
  | "MISSING_REFERENCE"
  | "UNKNOWN_QUOTE_SIZE"
  | "SHARES_BELOW_ONE"
  | "EXECUTABLE_PRICE_OUTSIDE_LEVELS"
  /** Target cannot exceed the configured round-trip friction. */
  | "NET_TARGET_NON_POSITIVE";

/** Versioned cost snapshot for new executions. `feePerTrade` remains only as
 * a compatibility input for immutable pre-v2 runs. */
export interface ExecutionCostSnapshot {
  readonly entryCommission: number;
  readonly exitCommission: number;
  readonly estimatedRegulatoryFees: number;
  readonly slippageBps: number;
  /** Native execution currency. Cross-currency aggregation is deliberately forbidden. */
  readonly currency: "CAD" | "USD";
  readonly brokerPricingVersion: string;
}

export type ExitReason =
  "TARGET" | "STOP" | "TIME_STOP" | "SESSION_CLOSE" | "SESSION_CLOSE_DELAYED";

export type ExecutionStatus =
  | "PENDING"
  | "OPEN"
  | "CLOSE_PENDING"
  | "CLOSED"
  | "NO_FILL"
  | "REJECTED_ECONOMICS";

/**
 * Why a structurally valid setup was refused on economic grounds
 * (docs/paper-bot-performance-improvement-plan.md Phase 2). These are
 * deliberately distinct from `NoFillReason`: the market was executable, the
 * trade simply could not pay for itself. `NET_TARGET_NON_POSITIVE` is the
 * mandatory invariant; the rest are configurable thresholds.
 */
export type EconomicsRejectionReason =
  | "NET_TARGET_NON_POSITIVE"
  | "SPREAD_COST_TOO_HIGH"
  | "STOP_DISTANCE_TOO_SMALL"
  | "TARGET_DISTANCE_TOO_SMALL"
  | "NET_REWARD_RISK_TOO_LOW";

/** Configurable, versioned economic-viability thresholds. */
export interface EconomicsGates {
  /** Minimum cost-inclusive reward/risk of the modeled target versus stop. */
  readonly minNetRewardRisk: number;
  /** Minimum stop distance as a multiple of modeled round-trip friction per share. */
  readonly minStopFrictionMultiple: number;
  /** Minimum target distance as a multiple of modeled round-trip friction per share. */
  readonly minTargetFrictionMultiple: number;
  /** Maximum quoted spread as a percentage of the executable entry price. */
  readonly maxSpreadPct: number;
}

/** Stop or target distance expressed in every unit the gates and reports need. */
export interface DistanceMeasures {
  readonly dollars: number;
  readonly percent: number;
  readonly ticks: number;
  /** Null for the candle model and for a zero/unknown spread. */
  readonly spreadMultiples: number | null;
  readonly frictionMultiples: number;
}

/**
 * The persisted economic evaluation of one candidate entry. Every gate input,
 * threshold, and reason code is captured so a rejection can be audited and
 * replayed without re-deriving market facts.
 */
export interface ExecutionEconomics {
  readonly policyVersion: string;
  readonly executableEntryPrice: number;
  readonly shares: number;
  readonly stop: number;
  readonly target: number;
  readonly expectedTargetExitPrice: number;
  readonly expectedTargetExitValue: number;
  readonly conservativeStopExitPrice: number;
  readonly conservativeStopExitValue: number;
  readonly expectedTargetNetPnl: number;
  readonly expectedStopNetPnl: number;
  readonly netRewardRisk: number | null;
  readonly stopDistance: DistanceMeasures;
  readonly targetDistance: DistanceMeasures;
  readonly spread: number | null;
  readonly spreadPct: number | null;
  readonly frictionPerShare: number;
  readonly fixedCosts: number;
  readonly costs: ExecutionCostSnapshot;
  readonly gates: EconomicsGates;
  /** Ordered by stable priority; empty when the candidate is viable. */
  readonly rejections: readonly EconomicsRejectionReason[];
}

/** Immutable per-run assumptions snapshot (private development record, "Execution Specification"). */
export interface AssumptionsSnapshot {
  readonly positionSize: number;
  readonly slippageBps: number;
  readonly feePerTrade: number;
  /** Present on v2 snapshots; omitted only by legacy persisted runs. */
  readonly costs?: ExecutionCostSnapshot;
  /** Dollar amount risked at the modeled stop. Defaults to fixed notional for legacy runs. */
  readonly riskBudget?: number;
  /** Independent notional cap after risk sizing. */
  readonly maxNotional?: number;
  /** Present on v2 snapshots; legacy runs apply the mandatory invariant only. */
  readonly economics?: EconomicsGates;
  readonly stopMethod: StopMethod;
  readonly atrStopMultiple: number;
  /** When set, overrides `event.targetReference` for every signal. */
  readonly rewardRiskRatio: number | null;
  readonly maxQuoteAgeSeconds: number;
  readonly sessionTimezone: string;
  /** Local HH:mm session-close boundary, normally "16:00" for TSX. */
  readonly noonCloseTime: string;
  /** Execution realism mode: unconstrained research projection (default) vs capacity-constrained portfolio simulation. */
  readonly executionMode?: ExecutionMode;
  /** Modeled decision or transmission latency in milliseconds. */
  readonly latencyMs?: number;
  /** Explicit research/replay provenance for the run. */
  readonly evidenceScope?: string;
}

/** The persisted `READY` setup event, reduced to what execution needs. */
export interface SignalFact {
  readonly entryReference: number | null;
  readonly stopReference: number | null;
  readonly targetReference: number | null;
  readonly atr14: number | null;
  readonly signalTimestamp: string;
}

export interface DerivedLevels {
  readonly stop: number;
  readonly target: number;
}

export type LevelDerivationResult =
  | ({ readonly ok: true } & DerivedLevels)
  | { readonly ok: false; readonly noFillReason: "MISSING_REFERENCE" };

/** A cap that reduced the risk-derived share count, in application order. */
export type SizingCap =
  | "RISK_BUDGET"
  | "POSITION_NOTIONAL"
  | "MAX_NOTIONAL"
  | "DISPLAYED_SIZE_PARTICIPATION"
  | "SYMBOL_EXPOSURE"
  | "SECTOR_EXPOSURE"
  | "PORTFOLIO_RISK";

/** Current exposure the sizing caps are measured against. Omitted entirely by
 * the independent per-strategy projection, which has no portfolio. */
export interface SizingContext {
  /** Displayed size on the entry side of the book, when known. */
  readonly displayedSize?: number;
  readonly openSymbolNotional?: number;
  readonly openSectorNotional?: number;
  readonly openPortfolioRisk?: number;
  readonly maxDisplayedSizeParticipation?: number;
  readonly maxSymbolNotional?: number;
  readonly maxSectorNotional?: number;
  readonly maxPortfolioRisk?: number;
  readonly executionMode?: ExecutionMode;
  readonly latencyMs?: number;
  readonly strategyKey?: string;
  readonly maximumHoldingMinutes?: number;
  readonly stalledBreakoutMinutes?: number;
  readonly stalledBreakoutMinProgressR?: number;
  readonly contexts?: readonly {
    signalKey: string;
    status: "UNAVAILABLE" | "WEAK" | "NEUTRAL" | "STRONG" | "STALE";
    timestamp: string;
  }[];
  /** Optional coordinated-context evidence carried into an explicit funded policy. */
  readonly contextStatus?:
    "UNAVAILABLE" | "WEAK" | "NEUTRAL" | "STRONG" | "STALE";
  readonly contextTimestamp?: string;
}

/** Auditable record of what the size would have been and what reduced it. */
export interface SizingBreakdown {
  readonly requestedRisk: number;
  readonly estimatedRisk: number;
  readonly costInclusiveLossPerShare: number;
  readonly uncappedShares: number;
  readonly shares: number;
  /** In capacity-constrained execution, the quantity requested that could not be filled. */
  readonly unfilledShares?: number;
  readonly appliedCaps: readonly SizingCap[];
}

export interface SizedEntry {
  readonly executableEntryPrice: number;
  readonly shares: number;
  readonly initialRisk: number;
  readonly sizing: SizingBreakdown;
}

export type EntrySizingResult =
  | ({ readonly ok: true } & SizedEntry)
  | {
      readonly ok: false;
      readonly noFillReason:
        "SHARES_BELOW_ONE" | "EXECUTABLE_PRICE_OUTSIDE_LEVELS";
    };

export interface ClosingFinancials {
  readonly exitPrice: number;
  readonly grossPnl: number;
  readonly netPnl: number;
  readonly rMultiple: number;
}

export type QuoteDataStatus = "REALTIME" | "DELAYED" | "HALTED";

/**
 * A single decision-time Level 1 quote, matched by instrument and timestamp.
 *
 * Note on `timestamp` and staleness: Questrade's Level 1 response carries no
 * exchange timestamp, so live ingest stamps each quote with its own receive
 * time (`Quote.receivedAt`, mirrored into `quote_snapshot.timestamp`).
 * `stalenessSeconds` and `maxQuoteAgeSeconds` therefore measure *ingest* age,
 * not exchange age: they detect a polling gap, not a slow exchange feed. A
 * feed that is merely behind is caught instead by `dataStatus`/`actionable`,
 * which come from the venue's own delay and halt flags. `STALE` consequently
 * fires mainly on the reconciliation path, where the nearest quote at or
 * before a signal can be several cycles old.
 */
export interface QuoteFact {
  readonly timestamp: string;
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
  /** Confirmed unit semantics from the provider. Missing legacy facts mean shares. */
  readonly sizeUnit?: "SHARES" | "BOARD_LOTS" | "UNKNOWN";
  readonly sizeMultiplier?: number;
  readonly dataStatus: QuoteDataStatus;
  readonly actionable: boolean;
}

export interface MarketSnapshot {
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
  readonly spread: number;
  readonly quoteTimestamp: string;
  readonly dataStatus: QuoteDataStatus;
  readonly stalenessSeconds: number;
  /** Explicit timing provenance (F-05) */
  readonly signalTimestamp?: string;
  readonly decisionTimestamp?: string;
  readonly fillTimestamp?: string;
  readonly latencyMs?: number;
  readonly executionMode?: ExecutionMode;
}

/** An OPEN or CLOSE_PENDING execution's fields needed to evaluate an exit. */
export interface OpenPosition {
  readonly remainingShares?: number;
  readonly exitFills?: readonly ExitOutcome[];
  readonly pendingExitReason?: ExitReason;
  readonly entryPrice: number;
  readonly entryTime: string;
  readonly stop: number;
  readonly target: number;
  readonly shares: number;
  readonly initialRisk: number;
  /** Explicit timing and execution mode provenance (F-05) */
  readonly quoteTime?: string;
  readonly signalTime?: string;
  readonly decisionTime?: string;
  readonly fillTime?: string;
  readonly latencyMs?: number;
  readonly executionMode?: ExecutionMode;
}

export interface EntryOutcome {
  readonly status: "OPEN";
  readonly economics: ExecutionEconomics;
  readonly sizing: SizingBreakdown;
  readonly entryTime: string;
  readonly stop: number;
  readonly target: number;
  readonly shares: number;
  readonly initialRisk: number;
  readonly executableEntryPrice: number;
  readonly entrySizeCoverage: number;
  readonly entryMarketSnapshot: MarketSnapshot;
  /** Explicit timing and execution mode provenance (F-05) */
  readonly quoteTime?: string;
  readonly signalTime?: string;
  readonly decisionTime?: string;
  readonly fillTime?: string;
  readonly latencyMs?: number;
  readonly executionMode?: ExecutionMode;
}

export interface NoFillOutcome {
  readonly status: "NO_FILL";
  readonly noFillReason: NoFillReason;
  readonly entryMarketSnapshot: MarketSnapshot | null;
}

/**
 * A tradable market that cannot pay for the modeled trade. Kept separate from
 * `NoFillOutcome` so reports never conflate "the market was unavailable" with
 * "the bot declined the economics".
 */
export interface RejectedEconomicsOutcome {
  readonly status: "REJECTED_ECONOMICS";
  readonly economicsReason: EconomicsRejectionReason;
  readonly economics: ExecutionEconomics;
  readonly entryMarketSnapshot: MarketSnapshot | null;
}

export type QuoteEntryResult =
  EntryOutcome | NoFillOutcome | RejectedEconomicsOutcome;

export interface ExitOutcome {
  readonly filledShares?: number;
  readonly triggered: true;
  readonly exitReason: ExitReason;
  readonly exitTime: string;
  readonly exitSizeCoverage: number;
  readonly exitMarketSnapshot: MarketSnapshot;
  readonly financials: ClosingFinancials;
  /** Set only for SESSION_CLOSE_DELAYED. */
  readonly sessionCloseDelayMs: number | null;
  /** In capacity-constrained execution, the quantity remaining unfilled on exit */
  readonly unfilledShares?: number;
}

export interface NoExitOutcome {
  readonly triggered: false;
}

export type QuoteExitResult = ExitOutcome | NoExitOutcome;

export interface SessionCloseResult {
  readonly status: "CLOSED" | "CLOSE_PENDING";
  readonly exit?: ExitOutcome;
}

/** A completed one-minute OHLC bar. Partially elapsed bars must never be passed in. */
export interface CandleFact {
  readonly start: string;
  readonly end: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export type CandleOpenPosition = OpenPosition;

export interface CandleEntryOutcome {
  readonly status: "OPEN";
  readonly economics: ExecutionEconomics;
  readonly sizing: SizingBreakdown;
  readonly entryTime: string;
  readonly stop: number;
  readonly target: number;
  readonly shares: number;
  readonly initialRisk: number;
  readonly syntheticEntryPrice: number;
}

export type CandleEntryResult =
  CandleEntryOutcome | NoFillOutcome | RejectedEconomicsOutcome;

export interface CandleExitOutcome {
  readonly triggered: true;
  readonly exitReason: ExitReason;
  readonly exitTime: string;
  readonly financials: ClosingFinancials;
}

export type CandleExitResult = CandleExitOutcome | NoExitOutcome;

export interface CandleSessionCloseResult {
  readonly status: "CLOSED" | "CLOSE_PENDING";
  readonly exit?: CandleExitOutcome;
}
