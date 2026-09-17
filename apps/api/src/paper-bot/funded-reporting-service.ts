import type { Pool } from "pg";
import {
  executionDiagnosticReportSchema,
  executionDiagnosticResponseSchema,
  paperPerformanceCurveSchema,
  paperTradeJournalSchema,
  type ExecutionDiagnosticResponse,
  type MarketId,
  type PaperEvidenceFilters,
  type PaperPerformanceCurve,
  type PaperPerformancePoint,
  type PaperTradeJournal,
} from "@tsx-scanner/contracts";
import { fundedAccountSummary, type FundedLedger } from "./funded-ledger.js";
import { reconstructFundedLedgerAt } from "./funded-ledger-repository.js";
import {
  fundedReconstructionMetrics,
  type FundedReconstructionMetricsRegistry,
} from "./funded-reconstruction-observability.js";
import type { PendingEntryOrder } from "./pending-order.js";
import {
  ExecutionDiagnosticsRepository,
  executionDiagnosticSourceDigest,
  type ExecutionDiagnosticsRequest,
} from "./execution-diagnostics-repository.js";
import { analyzeSnapshotReplenishment } from "./snapshot-replenishment-diagnostics.js";
import { explainResourceContention } from "./resource-contention-diagnostics.js";
import { ExecutionDiagnosticReportRepository } from "./execution-diagnostic-report-repository.js";

type SnapshotOrder = {
  instrumentId: string;
  state: PendingEntryOrder;
  runId?: string;
};

export class FundedReportingService {
  private readonly evidence: ExecutionDiagnosticsRepository;
  private readonly diagnosticReports: ExecutionDiagnosticReportRepository;

  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
    /**
     * The configured funded account per market. A market without a bound
     * account has no funded curve to draw; it is never inferred from
     * whichever account happens to have runs.
     */
    private readonly fundedAccountIds: Partial<Record<MarketId, string>> = {},
    private readonly reconstructionMetrics: FundedReconstructionMetricsRegistry = fundedReconstructionMetrics,
  ) {
    this.evidence = new ExecutionDiagnosticsRepository(pool);
    this.diagnosticReports = new ExecutionDiagnosticReportRepository(pool);
  }

  async buildExecutionDiagnostics(
    runId: string,
    request: ExecutionDiagnosticsRequest,
    reportVersion = "execution-diagnostics-v2",
  ) {
    const evidence = await this.evidence.load(runId, request);
    const sourceDigest = executionDiagnosticSourceDigest(evidence);
    return executionDiagnosticReportSchema.parse({
      reportVersion,
      sourceDigest,
      generatedAt: this.clock().toISOString(),
      scope: evidence.scope,
      replenishment: analyzeSnapshotReplenishment(evidence),
      contention: explainResourceContention(evidence),
    });
  }

  async saveExecutionDiagnostics(
    runId: string,
    request: ExecutionDiagnosticsRequest,
    reportVersion = "execution-diagnostics-v2",
  ) {
    const report = await this.buildExecutionDiagnostics(
      runId,
      request,
      reportVersion,
    );
    const identity = {
      runId,
      accountId: report.scope.accountId,
      marketId: report.scope.marketId,
      currency: report.scope.currency,
      temporalScope: report.scope.temporalScope,
      asOf: report.scope.asOf,
      reportVersion,
      sourceDigest: report.sourceDigest,
    } as const;
    return this.diagnosticReports.save(identity, report);
  }

  /** Read-only HTTP projection. RUN_END is served only from the immutable worker artifact;
   * explicit AS_OF/CURRENT_ACCOUNT requests are reconstructed read-only and never presented as
   * a replacement for a stored run-end report. */
  async getExecutionDiagnostics(
    runId: string,
    request: ExecutionDiagnosticsRequest,
  ): Promise<ExecutionDiagnosticResponse> {
    const target = await this.evidence.describe(runId, request);
    if (!target.asOf) {
      return executionDiagnosticResponseSchema.parse({
        status: "UNAVAILABLE",
        runId,
        accountId: target.accountId,
        marketId: target.marketId,
        currency: target.currency,
        temporalScope: target.temporalScope,
        asOf: null,
        reportId: null,
        jobId: null,
        reportVersion: null,
        sourceDigest: null,
        generatedAt: null,
        report: null,
        reason: "RUN_END_SNAPSHOT_UNAVAILABLE",
      });
    }

    if (request.mode === "RUN_END") {
      const stored = await this.diagnosticReports.findLatest(
        runId,
        "RUN_END",
        target.asOf,
        "execution-diagnostics-v2",
      );
      if (stored) {
        return executionDiagnosticResponseSchema.parse({
          status: "READY",
          runId,
          accountId: stored.identity.accountId,
          marketId: stored.identity.marketId,
          currency: stored.identity.currency,
          temporalScope: stored.identity.temporalScope,
          asOf: stored.identity.asOf,
          reportId: stored.id,
          jobId: null,
          reportVersion: stored.identity.reportVersion,
          sourceDigest: stored.identity.sourceDigest,
          generatedAt: stored.createdAt,
          report: stored.report,
          reason: null,
        });
      }
      const job = await this.diagnosticReports.findDiagnosticsJob(
        runId,
        "execution-diagnostics-v2",
      );
      const failedJob =
        job && ["FAILED", "CANCELLED", "INTERRUPTED"].includes(job.status);
      return executionDiagnosticResponseSchema.parse({
        status: failedJob ? "UNAVAILABLE" : "PENDING",
        runId,
        accountId: target.accountId,
        marketId: target.marketId,
        currency: target.currency,
        temporalScope: "RUN_END",
        asOf: target.asOf,
        reportId: null,
        jobId: job?.id ?? null,
        reportVersion: "execution-diagnostics-v2",
        sourceDigest: null,
        generatedAt: null,
        report: null,
        reason: failedJob
          ? `DIAGNOSTICS_JOB_${job.status}`
          : job
            ? "DIAGNOSTICS_JOB_PENDING"
            : "DIAGNOSTICS_NOT_PREPARED",
      });
    }

    const report = await this.buildExecutionDiagnostics(runId, request);
    return executionDiagnosticResponseSchema.parse({
      status: "READY",
      runId,
      accountId: target.accountId,
      marketId: target.marketId,
      currency: target.currency,
      temporalScope: report.scope.temporalScope,
      asOf: report.scope.asOf,
      reportId: null,
      jobId: null,
      reportVersion: report.reportVersion,
      sourceDigest: report.sourceDigest,
      generatedAt: report.generatedAt,
      report,
      reason: null,
    });
  }

  async report(
    runId: string,
    request?: string | { mode: "CURRENT_ACCOUNT" },
    maxMarkAgeMs = 30000,
  ) {
    const currentAccount = typeof request === "object";
    const at = typeof request === "string" ? request : undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<{
        account_id: string;
        currency: "CAD" | "USD";
        state: FundedLedger;
        initial_state: FundedLedger;
        market_id: string;
        execution_model_version: string;
        assumptions: unknown;
        status: string;
        source: string;
        session_date: string;
        policy: unknown;
        boundaryAt: Date | string | null;
        boundaryState: FundedLedger | null;
        boundaryOrders: SnapshotOrder[] | null;
      }>(
        `SELECT b.account_id,b.currency,b.policy,a.state,a.initial_state,
           r.market_id,r.execution_model_version,r.assumptions,r.status,r.source,
           r.session_date::text,s.boundary_at AS "boundaryAt",s.state AS "boundaryState",
           s.orders AS "boundaryOrders"
         FROM paper_funded_run b
         JOIN paper_funded_account a ON a.id=b.account_id
         JOIN paper_bot_run r ON r.id=b.run_id
         LEFT JOIN paper_funded_run_snapshot s ON s.run_id=b.run_id
         WHERE b.run_id=$1`,
        [runId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Run has no funded account binding");
      const boundaryAt = row.boundaryAt
        ? row.boundaryAt instanceof Date
          ? row.boundaryAt.toISOString()
          : new Date(row.boundaryAt).toISOString()
        : null;
      const requestedAt = currentAccount
        ? new Date().toISOString()
        : at
          ? new Date(at).toISOString()
          : boundaryAt;
      if (!requestedAt)
        throw new Error(
          "Funded run-end snapshot is unavailable; provide a proven historical as-of time",
        );
      if (at && boundaryAt && Date.parse(at) > Date.parse(boundaryAt))
        throw new Error(
          "Historical funded report time is after the completed run boundary",
        );
      let state: FundedLedger;
      let snapshotOrders: SnapshotOrder[] | null = null;
      let temporalScope: "RUN_END" | "AS_OF" | "CURRENT_ACCOUNT";
      if (currentAccount) {
        state = row.state;
        temporalScope = "CURRENT_ACCOUNT";
        // Current balances and orders belong to the whole account, even when
        // the caller selected an older run to identify that account. No event
        // replay or historical sequencing proof is required for this view.
        snapshotOrders = (
          await client.query<SnapshotOrder>(
            `SELECT o.instrument_id AS "instrumentId",o.state,o.run_id AS "runId"
           FROM paper_entry_order o JOIN paper_funded_run b ON b.run_id=o.run_id
           WHERE b.account_id=$1 ORDER BY o.created_at,o.order_id`,
            [row.account_id],
          )
        ).rows;
      } else if (!at && row.boundaryState && row.boundaryOrders) {
        state = row.boundaryState;
        snapshotOrders = row.boundaryOrders;
        temporalScope = "RUN_END";
      } else if (
        boundaryAt &&
        Date.parse(requestedAt) === Date.parse(boundaryAt) &&
        row.boundaryState
      ) {
        state = row.boundaryState;
        snapshotOrders = row.boundaryOrders;
        temporalScope = "AS_OF";
      } else {
        // Same shared bounded reconstruction primitive as the FP01 decision
        // capture: newest provable checkpoint, only the events after its
        // anchor, verified ordering, bounded duplicate-history cache. A
        // window that cannot be proven or exceeds the event budget fails
        // closed instead of replaying an ever-growing account history.
        const reconstruction = await reconstructFundedLedgerAt(
          client,
          row.account_id,
          requestedAt,
          {
            onReconstruction: (observation) =>
              this.reconstructionMetrics.observe(row.account_id, observation),
          },
          maxMarkAgeMs,
        );
        state = reconstruction.ledger;
        temporalScope = "AS_OF";
      }
      if (row.currency !== state.currency)
        throw new Error("Funded report currency mismatch");
      const orders = snapshotOrders
        ? { rows: snapshotOrders }
        : await client.query<SnapshotOrder>(
            `SELECT instrument_id AS "instrumentId",state
             FROM (
               SELECT o.instrument_id,h.state,h.fact_at,h.revision,
                 row_number() OVER (
                   PARTITION BY h.order_id ORDER BY h.fact_at DESC,h.revision DESC
                 ) AS rank
               FROM paper_entry_order_history h
               JOIN paper_entry_order o ON o.order_id=h.order_id
               WHERE o.run_id=$1 AND h.fact_at <= $2::timestamptz
             ) historical
             WHERE rank=1
             ORDER BY fact_at,revision, instrument_id`,
            [runId, requestedAt],
          );
      const summary = fundedAccountSummary(state, requestedAt, maxMarkAgeMs);
      const report = {
        projection: "FUNDED_CASH_SIMULATION" as const,
        qualifiedForCapitalAllocation: false,
        qualificationReason:
          "Out-of-sample and walk-forward qualification is not established by execution reporting",
        runId,
        accountId: row.account_id,
        asOf: requestedAt,
        temporalScope,
        accountSession: state.session,
        ordersScope: currentAccount ? "ACCOUNT" : "RUN",
        cohort: {
          marketId: row.market_id,
          currency: row.currency,
          executionModelVersion: row.execution_model_version,
          ledgerVersion: state.version,
          source: row.source,
          sessionDate: row.session_date,
          assumptions: row.assumptions,
          fundedPolicy: row.policy ?? null,
        },
        runStatus: row.status,
        summary,
        positions: state.positions,
        reservations: state.reservations,
        orders: orders.rows.map((order) => ({
          ...(order.runId ? { runId: order.runId } : {}),
          instrumentId: order.instrumentId,
          ...order.state,
        })),
        warnings: [
          ...(!row.policy ? ["UNKNOWN_FUNDED_POLICY"] : []),
          ...(summary.staleMarks ? ["STALE_POSITION_MARKS"] : []),
          ...(!summary.entriesAllowed ? ["FUNDED_ENTRIES_BLOCKED"] : []),
          ...(orders.rows.some(
            (order) => order.state.execution?.status === "CLOSE_PENDING",
          )
            ? ["UNRESOLVED_CLOSE_QUANTITY"]
            : []),
          "SIMULATED_LIQUIDITY_NOT_GUARANTEED",
        ],
      };
      await client.query("COMMIT");
      return report;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The funded account's $ performance over time, one point per completed
   * funded run. Equity is derived from the immutable run-end snapshot and
   * never from a later mark, so a run whose boundary was never captured stays
   * unavailable instead of being backfilled from current balances.
   */
  async performanceCurve(
    marketId: MarketId = "CA_TSX",
    range: { startDate: string; endDate: string },
    source?: string,
  ): Promise<PaperPerformanceCurve> {
    const configuredCurrency = marketId === "CA_TSX" ? "CAD" : "USD";
    const accountId = this.fundedAccountIds[marketId];
    if (!accountId)
      return paperPerformanceCurveSchema.parse({
        account: "FUNDED",
        marketId,
        currency: configuredCurrency,
        granularity: "DAY",
        startDate: range.startDate,
        endDate: range.endDate,
        points: [],
        warnings: ["FUNDED_ACCOUNT_NOT_CONFIGURED"],
      });

    const rows = await this.pool.query<{
      currency: "CAD" | "USD";
      sessionDate: string;
      boundaryAt: Date | string;
      boundaryState: FundedLedger;
      initialState: FundedLedger;
      orders: SnapshotOrder[];
    }>(
      `SELECT b.currency,r.session_date::text AS "sessionDate",
         s.boundary_at AS "boundaryAt",s.state AS "boundaryState",
         a.initial_state AS "initialState",s.orders
       FROM paper_funded_run_snapshot s
       JOIN paper_funded_run b ON b.run_id=s.run_id
       JOIN paper_funded_account a ON a.id=b.account_id
       JOIN paper_bot_run r ON r.id=b.run_id
       WHERE r.market_id=$1 AND b.account_id=$2
         AND ($3::text IS NULL OR r.source=$3)
         AND r.session_date <= $4::date
       ORDER BY r.session_date,s.boundary_at`,
      [marketId, accountId, source ?? null, range.endDate],
    );
    // A completed run without a retained boundary is permanent evidence loss
    // for this account, so it is disclosed rather than silently dropped.
    const missing = await this.pool.query<{ missing: number | string }>(
      `SELECT count(*)::int AS missing
       FROM paper_funded_run b
       JOIN paper_bot_run r ON r.id=b.run_id
       LEFT JOIN paper_funded_run_snapshot s ON s.run_id=b.run_id
       WHERE r.market_id=$1 AND b.account_id=$2
         AND ($3::text IS NULL OR r.source=$3)
         AND r.session_date >= $4::date AND r.session_date <= $5::date
         AND r.status='COMPLETED' AND s.run_id IS NULL`,
      [marketId, accountId, source ?? null, range.startDate, range.endDate],
    );

    const valuation = rows.rows.map((row) => {
      const boundaryAt = boundaryIso(row.boundaryAt);
      if (row.currency !== row.boundaryState.currency)
        throw new Error("Funded performance currency mismatch");
      const summary = fundedAccountSummary(
        row.boundaryState,
        boundaryAt,
        FUNDED_PERFORMANCE_MARK_AGE_MS,
      );
      const initial = fundedAccountSummary(
        row.initialState,
        boundaryAt,
        FUNDED_PERFORMANCE_MARK_AGE_MS,
      );
      return {
        sessionDate: row.sessionDate,
        closedAt: boundaryAt,
        cumulative: cents(summary.equity - initial.equity),
        currency: row.currency,
        trades: closedTradesIn(row.orders),
      };
    });
    // Rebase the account's cumulative P&L to the last completed boundary
    // before the range, so the curve measures the selected period rather
    // than account inception.
    const firstInRange = valuation.findIndex(
      (value) => value.sessionDate >= range.startDate,
    );
    const baseline =
      firstInRange > 0 ? valuation[firstInRange - 1]!.cumulative : 0;
    const points: PaperPerformancePoint[] = [];
    let previous = 0;
    for (const value of firstInRange < 0 ? [] : valuation.slice(firstInRange)) {
      const cumulative = cents(value.cumulative - baseline);
      points.push({
        sessionDate: value.sessionDate,
        closedAt: value.closedAt,
        netPnl: cents(cumulative - previous),
        cumulativeNetPnl: cumulative,
        trades: value.trades,
      });
      previous = cumulative;
    }

    return paperPerformanceCurveSchema.parse({
      account: "FUNDED",
      marketId,
      currency: valuation[0]?.currency ?? configuredCurrency,
      granularity: "DAY",
      startDate: range.startDate,
      endDate: range.endDate,
      points,
      warnings:
        Number(missing.rows[0]?.missing ?? 0) > 0
          ? ["FUNDED_RUN_BOUNDARY_UNAVAILABLE"]
          : [],
    });
  }

  /**
   * The funded paper account's filled-order ledger, one row per submission
   * that actually opened a position. It reads the funded account's own orders,
   * never the shadow portfolios, and a submission that never filled stays a
   * decision rather than becoming a journal trade.
   */
  async journal(
    filters: PaperEvidenceFilters,
    limit = 200,
  ): Promise<PaperTradeJournal> {
    const marketId = filters.marketId ?? "CA_TSX";
    const accountId = this.fundedAccountIds[marketId];
    if (!accountId)
      return paperTradeJournalSchema.parse({
        projection: "FUNDED",
        entries: [],
        totals: EMPTY_FUNDED_JOURNAL_TOTALS,
        unresolvedPositions: [],
      });
    const values = [
      accountId,
      marketId,
      filters.source ?? null,
      filters.startDate ?? null,
      filters.endDate ?? null,
    ];
    const entries = await this.pool.query<FundedJournalEntryRow>(
      `WITH ledger AS (${FUNDED_JOURNAL_LEDGER})
       SELECT l.*,l."grossPnl"-l."netPnl" AS costs,
         CASE WHEN l.status='CLOSED' THEN sum(l."netPnl")
           OVER (ORDER BY l."exitTime",l.id ROWS UNBOUNDED PRECEDING) END AS "runningNetPnl"
       FROM ledger l
       ORDER BY coalesce(l."exitTime",l."entryTime") DESC NULLS LAST,l.id DESC
       LIMIT $6`,
      [...values, limit],
    );
    const totals = await this.pool.query<FundedJournalTotalsRow>(
      `WITH ledger AS (${FUNDED_JOURNAL_LEDGER}) ${FUNDED_JOURNAL_TOTALS}`,
      values,
    );
    // Unresolved orders are account-wide, matching the coordinated journal:
    // the latest session's backlog must stay visible even when a reader is
    // looking at an older date window.
    const unresolved = await this.pool.query<{
      id: string;
      symbol: string;
      sessionDate: Date | string;
      status: "OPEN" | "CLOSE_PENDING";
      runStatus: "RUNNING" | "CLOSE_PENDING" | "COMPLETED" | "FAILED";
      entryTime: Date | string | null;
      lastFactTimestamp: Date | string | null;
      ageMs: number | string;
    }>(
      `SELECT o.order_id AS id,i.symbol,r.session_date AS "sessionDate",
         o.state->'execution'->>'status' AS status,r.status AS "runStatus",
         (o.state->'execution'->'position'->>'entryTime')::timestamptz AS "entryTime",
         coalesce(o.last_fact_at,
           (o.state->'execution'->'position'->>'entryTime')::timestamptz,
           o.created_at) AS "lastFactTimestamp",
         greatest(0,extract(epoch FROM (now()-coalesce(o.last_fact_at,
           (o.state->'execution'->'position'->>'entryTime')::timestamptz,
           o.created_at)))*1000)::bigint AS "ageMs"
       FROM paper_entry_order o
       JOIN paper_funded_run b ON b.run_id=o.run_id
       JOIN paper_bot_run r ON r.id=o.run_id
       JOIN instrument i ON i.id=o.instrument_id
       WHERE b.account_id=$1 AND r.market_id=$2
         AND ($3::text IS NULL OR r.source=$3)
         AND o.state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING')
       ORDER BY r.session_date,o.created_at`,
      [accountId, marketId, filters.source ?? null],
    );
    const row = totals.rows[0];
    const closedTrades = asCount(row?.closed_trades);
    const lost = asNumber(row?.lost_net_pnl) ?? 0;
    return paperTradeJournalSchema.parse({
      projection: "FUNDED",
      entries: entries.rows.map((entry) => ({
        id: entry.id,
        runId: entry.runId,
        sessionDate: asIso(entry.sessionDate)!.slice(0, 10),
        symbol: entry.symbol,
        strategyKey: entry.strategyKey,
        profileName: entry.profileName,
        configVersion: entry.configVersion,
        status: entry.status,
        entryPrice: asNumber(entry.entryPrice),
        entryTime: asIso(entry.entryTime),
        stopPrice: asNumber(entry.stopPrice),
        targetPrice: asNumber(entry.targetPrice),
        shares: asNumber(entry.shares),
        initialRisk: asNumber(entry.initialRisk),
        requestedRisk: asNumber(entry.requestedRisk),
        riskDeploymentRatio:
          asNumber(entry.requestedRisk) && asNumber(entry.initialRisk) !== null
            ? asNumber(entry.initialRisk)! / asNumber(entry.requestedRisk)!
            : null,
        bindingCaps: Array.isArray(entry.bindingCaps) ? entry.bindingCaps : [],
        exitPrice: asNumber(entry.exitPrice),
        exitTime: asIso(entry.exitTime),
        exitReason: entry.exitReason,
        grossPnl: asNumber(entry.grossPnl),
        costs: asNumber(entry.costs),
        netPnl: asNumber(entry.netPnl),
        rMultiple: asNumber(entry.rMultiple),
        runningNetPnl: asNumber(entry.runningNetPnl),
        lastFactTimestamp: asIso(entry.lastFactTimestamp),
      })),
      totals: {
        closedTrades,
        openPositions: asCount(row?.open_positions),
        wins: asCount(row?.wins),
        losses: asCount(row?.losses),
        scratches: asCount(row?.scratches),
        winRate: {
          numerator: asCount(row?.wins),
          denominator: closedTrades,
          value: closedTrades === 0 ? null : asCount(row?.wins) / closedTrades,
        },
        grossPnl: asNumber(row?.gross_pnl) ?? 0,
        costs: asNumber(row?.costs) ?? 0,
        netPnl: asNumber(row?.net_pnl) ?? 0,
        // Undefined without a loss to divide by, rather than infinite.
        profitFactor:
          lost === 0 ? null : (asNumber(row?.won_net_pnl) ?? 0) / lost,
        cumulativeR: asNumber(row?.cumulative_r) ?? 0,
        averageR: asNumber(row?.average_r),
        largestWin: asNumber(row?.largest_win),
        largestLoss: asNumber(row?.largest_loss),
      },
      unresolvedPositions: unresolved.rows.map((position) => ({
        id: position.id,
        symbol: position.symbol,
        sessionDate: asIso(position.sessionDate)!.slice(0, 10),
        status: position.status,
        runStatus: position.runStatus,
        entryTime: asIso(position.entryTime),
        lastFactTimestamp: asIso(position.lastFactTimestamp),
        ageMs: Number(position.ageMs),
      })),
    });
  }
}

const FUNDED_PERFORMANCE_MARK_AGE_MS = 30_000;

function boundaryIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

const cents = (value: number): number => Number(value.toFixed(2));

/** Closed exits already recorded in the run-end snapshot, never live orders. */
function closedTradesIn(orders: SnapshotOrder[]): number {
  return orders.filter((order) => order.state.execution?.status === "CLOSED")
    .length;
}

const asNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const asCount = (value: unknown): number => Number(value ?? 0);
const asIso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const EMPTY_FUNDED_JOURNAL_TOTALS = {
  closedTrades: 0,
  openPositions: 0,
  wins: 0,
  losses: 0,
  scratches: 0,
  winRate: { numerator: 0, denominator: 0, value: null },
  grossPnl: 0,
  costs: 0,
  netPnl: 0,
  profitFactor: null,
  cumulativeR: 0,
  averageR: null,
  largestWin: null,
  largestLoss: null,
} as const;

/**
 * The funded account's filled orders. Every live and historical funded
 * submission uses the originating observation id as its order id, so
 * profile/strategy provenance is joined back when it exists and falls back to
 * the submission's own context. Unfilled, cancelled and rejected submissions
 * are decisions, not trades, and never enter this ledger.
 */
const FUNDED_JOURNAL_LEDGER = `
  SELECT o.order_id AS id,o.run_id AS "runId",r.session_date AS "sessionDate",
    i.symbol,
    coalesce(o.submission->'context'->>'strategyKey',obs.strategy_key,'FUNDED') AS "strategyKey",
    coalesce(obs.profile_name,'Funded paper account') AS "profileName",
    coalesce(obs.config_version,b.policy->>'version','FUNDED') AS "configVersion",
    o.state->'execution'->>'status' AS status,
    (o.state->'execution'->'position'->>'entryPrice')::numeric AS "entryPrice",
    (o.state->'execution'->'position'->>'entryTime')::timestamptz AS "entryTime",
    (o.state->'execution'->'position'->>'stop')::numeric AS "stopPrice",
    (o.state->'execution'->'position'->>'target')::numeric AS "targetPrice",
    (o.state->'execution'->'position'->>'shares')::bigint AS shares,
    (o.state->'execution'->'position'->>'initialRisk')::numeric AS "initialRisk",
    (o.state->'execution'->'sizing'->>'requestedRisk')::numeric AS "requestedRisk",
    o.state->'execution'->'sizing'->'appliedCaps' AS "bindingCaps",
    (o.state->'execution'->'exit'->'financials'->>'exitPrice')::numeric AS "exitPrice",
    (o.state->'execution'->'exit'->>'exitTime')::timestamptz AS "exitTime",
    o.state->'execution'->'exit'->>'exitReason' AS "exitReason",
    (o.state->'execution'->'exit'->'financials'->>'grossPnl')::numeric AS "grossPnl",
    (o.state->'execution'->'exit'->'financials'->>'netPnl')::numeric AS "netPnl",
    (o.state->'execution'->'exit'->'financials'->>'rMultiple')::numeric AS "rMultiple",
    o.last_fact_at AS "lastFactTimestamp"
  FROM paper_entry_order o
  JOIN paper_funded_run b ON b.run_id=o.run_id
  JOIN paper_bot_run r ON r.id=o.run_id
  JOIN instrument i ON i.id=o.instrument_id
  LEFT JOIN paper_signal_observation obs ON obs.id::text=o.order_id
  WHERE b.account_id=$1 AND r.market_id=$2
    AND ($3::text IS NULL OR r.source=$3)
    AND ($4::date IS NULL OR r.session_date >= $4::date)
    AND ($5::date IS NULL OR r.session_date <= $5::date)
    AND o.state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING','CLOSED')`;

const FUNDED_JOURNAL_TOTALS = `
  SELECT count(*) FILTER (WHERE status='CLOSED')::int AS closed_trades,
    count(*) FILTER (WHERE status IN ('OPEN','CLOSE_PENDING'))::int AS open_positions,
    count(*) FILTER (WHERE status='CLOSED' AND round("netPnl",2)>0)::int AS wins,
    count(*) FILTER (WHERE status='CLOSED' AND round("netPnl",2)<0)::int AS losses,
    count(*) FILTER (WHERE status='CLOSED' AND round("netPnl",2)=0)::int AS scratches,
    coalesce(sum("grossPnl") FILTER (WHERE status='CLOSED'),0) AS gross_pnl,
    coalesce(sum("grossPnl"-"netPnl") FILTER (WHERE status='CLOSED'),0) AS costs,
    coalesce(sum("netPnl") FILTER (WHERE status='CLOSED'),0) AS net_pnl,
    coalesce(sum("netPnl") FILTER (WHERE status='CLOSED' AND round("netPnl",2)>0),0) AS won_net_pnl,
    coalesce(-sum("netPnl") FILTER (WHERE status='CLOSED' AND round("netPnl",2)<0),0) AS lost_net_pnl,
    coalesce(sum("rMultiple") FILTER (WHERE status='CLOSED'),0) AS cumulative_r,
    avg("rMultiple") FILTER (WHERE status='CLOSED') AS average_r,
    max("netPnl") FILTER (WHERE status='CLOSED' AND round("netPnl",2)>0) AS largest_win,
    min("netPnl") FILTER (WHERE status='CLOSED' AND round("netPnl",2)<0) AS largest_loss
  FROM ledger`;

interface FundedJournalEntryRow {
  id: string;
  runId: string;
  sessionDate: Date | string;
  symbol: string;
  strategyKey: string;
  profileName: string;
  configVersion: string;
  status: "OPEN" | "CLOSE_PENDING" | "CLOSED";
  entryPrice: number | string | null;
  entryTime: Date | string | null;
  stopPrice: number | string | null;
  targetPrice: number | string | null;
  shares: number | string | null;
  initialRisk: number | string | null;
  requestedRisk: number | string | null;
  bindingCaps: unknown;
  exitPrice: number | string | null;
  exitTime: Date | string | null;
  exitReason: string | null;
  grossPnl: number | string | null;
  netPnl: number | string | null;
  rMultiple: number | string | null;
  costs: number | string | null;
  runningNetPnl: number | string | null;
  lastFactTimestamp: Date | string | null;
}

interface FundedJournalTotalsRow {
  closed_trades: number | string;
  open_positions: number | string;
  wins: number | string;
  losses: number | string;
  scratches: number | string;
  gross_pnl: number | string | null;
  costs: number | string | null;
  net_pnl: number | string | null;
  won_net_pnl: number | string | null;
  lost_net_pnl: number | string | null;
  cumulative_r: number | string | null;
  average_r: number | string | null;
  largest_win: number | string | null;
  largest_loss: number | string | null;
}
