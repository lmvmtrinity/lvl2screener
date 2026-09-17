import type {
  PaperBotActivity,
  PaperBotRun,
  PaperCohortAggregate,
  PaperCohortCurvePoint,
  PaperCommissionSensitivity,
  PaperCoordinationDecision,
  PaperCoordinationSummary,
  PaperEvidenceComparison,
  PaperEvidenceFilters,
  PaperExecution,
  PaperJournalProjection,
  PaperModelDivergence,
  PaperPerformanceCurve,
  PaperPerformanceGranularity,
  PaperProfileQualification,
  PaperSignalObservation,
  PaperTradeJournal,
} from "@tsx-scanner/contracts";
import { DomainError } from "../errors.js";
import type {
  HistoricalUnavailable,
  PaperEvidenceStore,
} from "./paper-reporting-repository.js";

export class PaperReportingError extends DomainError {
  constructor(
    readonly code: "INVALID_COMPARISON",
    message: string,
  ) {
    super(code, message, 422);
  }
}

/** Zero (current Questrade CAD equities), nominal, and the legacy assumption. */
export const COMMISSION_SENSITIVITY_SCENARIOS = [0, 1, 9.95] as const;

export class PaperReportingService {
  constructor(private readonly store: PaperEvidenceStore) {}

  listActivities(
    filters: PaperEvidenceFilters,
    limit = 100,
  ): Promise<PaperBotActivity[]> {
    return this.store.listActivities(filters, limit);
  }

  listRuns(filters: PaperEvidenceFilters, limit = 100): Promise<PaperBotRun[]> {
    return this.store.listRuns(filters, limit);
  }
  listObservations(
    filters: PaperEvidenceFilters,
    limit = 200,
  ): Promise<PaperSignalObservation[]> {
    return this.store.listObservations(filters, limit);
  }
  listExecutions(
    filters: PaperEvidenceFilters,
    limit = 200,
  ): Promise<PaperExecution[]> {
    return this.store.listExecutions(filters, limit);
  }
  aggregates(filters: PaperEvidenceFilters): Promise<PaperCohortAggregate[]> {
    return this.store.aggregates(filters);
  }
  /**
   * Discloses how much of a cohort's result depends on its commission
   * assumption. The default scenarios span Questrade's current $0 CAD-equity
   * commission, a nominal $1, and the legacy $9.95 the early cohorts were
   * generated under (docs/paper-bot-performance-improvement-plan.md, Phase 1).
   */
  async commissionSensitivity(
    filters: PaperEvidenceFilters,
    roundTripCommissions: readonly number[] = COMMISSION_SENSITIVITY_SCENARIOS,
  ): Promise<PaperCommissionSensitivity[]> {
    const scenarios = [...new Set(roundTripCommissions)].sort(
      (left, right) => left - right,
    );
    if (scenarios.length === 0)
      throw new PaperReportingError(
        "INVALID_COMPARISON",
        "At least one round-trip commission scenario is required.",
      );
    if (scenarios.some((value) => !Number.isFinite(value) || value < 0))
      throw new PaperReportingError(
        "INVALID_COMPARISON",
        "Round-trip commission scenarios must be finite, non-negative amounts.",
      );
    return this.store.commissionSensitivity(filters, scenarios);
  }
  curves(filters: PaperEvidenceFilters): Promise<PaperCohortCurvePoint[]> {
    return this.store.curves(filters);
  }
  /**
   * The coordinated shadow portfolio, kept as its own surface so a reader
   * cannot accidentally add it to the independent per-strategy evidence: one
   * is a portfolio simulation, the other is unbiased strategy evidence.
   */
  coordinationDecisions(
    filters: PaperEvidenceFilters,
    limit = 200,
  ): Promise<PaperCoordinationDecision[]> {
    return this.store.coordinationDecisions(filters, limit);
  }
  coordinationSummary(
    filters: PaperEvidenceFilters,
  ): Promise<PaperCoordinationSummary> {
    return this.store.coordinationSummary(filters);
  }
  divergences(filters: PaperEvidenceFilters): Promise<PaperModelDivergence[]> {
    return this.store.divergences(filters);
  }
  qualifications(
    filters: PaperEvidenceFilters,
  ): Promise<PaperProfileQualification[]> {
    return this.store.qualifications(filters);
  }

  /**
   * The bot's P&L ledger for one shadow projection. The independent projection
   * defaults to the canonical quote model: without that default an unfiltered
   * request would total a symbol's quote and candle executions together, and
   * ADR-009 makes the candle output supplementary, never additive. The
   * coordinated projection has no per-model executions to choose between, and
   * the funded account is served by the funded reporting service.
   */
  journal(
    filters: PaperEvidenceFilters,
    projection: PaperJournalProjection,
    limit = 200,
  ): Promise<PaperTradeJournal> {
    if (projection === "FUNDED")
      throw new Error(
        "Funded journal is served by the funded reporting service",
      );
    return this.store.journal(
      projection === "INDEPENDENT"
        ? { ...filters, model: filters.model ?? "QUOTE" }
        : filters,
      projection,
      limit,
    );
  }

  /**
   * The coordinated account's realized-P&L curve over an explicit session
   * range. The projection is fixed by the contract: only one account ever
   * held these positions, and independent evidence stays on the journal.
   */
  performanceCurve(
    filters: PaperEvidenceFilters,
    range: { startDate: string; endDate: string },
    granularity: PaperPerformanceGranularity = "DAY",
  ): Promise<PaperPerformanceCurve> {
    return this.store.performanceCurve(filters, range, granularity);
  }

  async comparisons(
    filters: PaperEvidenceFilters,
  ): Promise<PaperEvidenceComparison[]> {
    if (filters.source && filters.source !== "LIVE")
      throw new PaperReportingError(
        "INVALID_COMPARISON",
        "Forward comparison accepts LIVE paper evidence only; historical executions are selected through exact profile-evidence provenance.",
      );
    if (filters.model && filters.model !== "QUOTE")
      throw new PaperReportingError(
        "INVALID_COMPARISON",
        "Forward/backtest comparison is canonical quote-model only; candle results remain supplementary.",
      );
    const aggregates = await this.store.aggregates({
      ...filters,
      source: "LIVE",
      model: "QUOTE",
    });
    return Promise.all(
      aggregates.map(async (forward) => {
        const historical = await this.store.historicalFor(forward);
        if ("reason" in historical)
          return {
            forward,
            comparable: false,
            reason: historical.reason,
            historical: null,
          };
        return comparison(forward, historical);
      }),
    );
  }
}

function comparison(
  forward: PaperCohortAggregate,
  historical: Exclude<
    Awaited<ReturnType<PaperEvidenceStore["historicalFor"]>>,
    HistoricalUnavailable
  >,
): PaperEvidenceComparison {
  const expectancy = historical.averageR;
  return {
    forward,
    comparable: true,
    reason: null,
    historical: {
      backtestRunId: historical.backtestRunId,
      closedTrades: historical.closedTrades,
      winRate: {
        numerator: historical.wins,
        denominator: historical.closedTrades,
        value:
          historical.closedTrades === 0
            ? null
            : historical.wins / historical.closedTrades,
      },
      averageR: historical.averageR,
      expectancyR: expectancy,
      cumulativeR: historical.cumulativeR,
      exitReasons: historical.exitReasons,
    },
  };
}
